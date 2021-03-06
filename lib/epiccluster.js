var util = require('util');
var events = require('events');
var net = require('net');
var cluster = require('cluster');
var uuid = require('node-uuid');
var couchbase = require('couchbase');
var log = require('./logger');
var core = require('./core');

var PORT_START = 6400 + process.portOffset;

function _Client(parent, uuid, socket) {
  var self = this;

  this.parent = parent;
  this.uuid = uuid;
  this.socket = socket;
  this.buffer = null;
  this.onMap = {};
  this.sweepNum = -1;
  this.registered = false;

  socket.on('connect', function() {
    self.nemit('handshake_syn', {
      uuid: self.parent.uuid,
      target_uuid: self.uuid
    });
  });
  socket.on('data', function(data) {
    self._onData(data);
  });
  socket.on('error', function(e) {
  });
  socket.on('close', function() {
    if (self.registered) {
      self.parent.emit('nodeLeft', self.uuid);
      self.registered = false;
    }

    self.parent._unregisterNode(self);
  });


  this.non('handshake_syn', function(args) {
    if (args.target_uuid !== self.parent.uuid) {
      self.close();
      return;
    }

    for (var i = 0; i < self.parent.nodes.length; ++i) {
      var oNode = self.parent.nodes[i];
      if (oNode.uuid === args.uuid) {
        self.close();
        return;
      }
    }

    self.uuid = args.uuid;

    self.nemit('handshake_ack');

    self.registered = true;
    self.parent.emit('nodeJoined', self);
  });
  this.non('handshake_ack', function(args) {
    if (self.registered) {
      throw new Error('node already registered');
    }

    self.registered = true;
    self.parent.emit('nodeJoined', self);
  });
}

_Client.prototype.debugInfo = function() {
  return {
    uuid: this.uuid,
    host: this.socket.remoteAddress,
    port: this.socket.remotePort
  };
};

_Client.prototype.close = function() {
  this.socket.end();
};

_Client.prototype._nemit = function(cmd, args) {
  var handlers = this.onMap[cmd];
  if (handlers) {
    for (var i = 0; i < handlers.length; ++i) {
      handlers[i](args);
    }
  }

  this.parent._nemit(this, cmd, args);
};

_Client.prototype.non = function(cmd, handler) {
  if (!this.onMap[cmd]) {
    this.onMap[cmd] = [];
  }
  this.onMap[cmd].push(handler);
};

/**
 * @param cmd
 * @param [args]
 */
_Client.prototype.nemit = function(cmd, args) {
  var dataStr = JSON.stringify([cmd, args]);
  var dataLength = Buffer.byteLength(dataStr);
  var buffer = new Buffer(2 + dataLength);
  buffer.writeInt16BE(2+dataLength, 0);
  buffer.write(dataStr, 2);
  this.socket.write(buffer);
};

_Client.prototype._onData = function(data) {
  if (!this.buffer) {
    this.buffer = data;
  } else {
    this.buffer = Buffer.concat([this.buffer, data]);
  }

  while(true) {
    if (this.buffer.length < 2) {
      break;
    }

    var packetLength = this.buffer.readUInt16BE(0);
    if (this.buffer.length < packetLength) {
      break;
    }

    var dataStr = this.buffer.toString('utf8', 2, packetLength);
    var cmdInfo = JSON.parse(dataStr);

    this._nemit(cmdInfo[0], cmdInfo[1]);

    this.buffer = this.buffer.slice(packetLength);
  }
};

function EpicCluster(db) {
  this.db = db;

  this.uuid = core.uuid();
  this.host = core.localIp();
  this.port = 0;
  this.onMap = {};

  this.nodeSweepNum = 0;
  this.nodes = [];

  this._startListening();
}
util.inherits(EpicCluster, events.EventEmitter);

EpicCluster.prototype.debugInfo = function() {
  var out = {};

  out.uuid = this.uuid;
  out.host = this.host;
  out.port = this.port;

  out.nodes = [];
  for (var i = 0; i < this.nodes.length; ++i) {
    out.nodes.push(this.nodes[i].debugInfo());
  }

  return out;
};

EpicCluster.prototype._startListening = function() {
  var self = this;

  this.port = PORT_START;

  this.server = net.createServer();
  this.server.on('connection', function(sock) {
    self.nodes.push(new _Client(self, null, sock));
  });

  this.server.on('error', function serverError(e) {
    if (e.code === 'EADDRINUSE') {
      if (self.port > PORT_START + 100) {
        throw new Error('could not find a port to run on');
      }

      // try next port
      self.server.listen(self.port++);
    } else {
      throw e;
    }
  });
  this.server.on('listening', function() {
    log.info('EpicCluster Online as `' + self.uuid + '`@' +
        self.host + ':' + self.port);

    self.emit('ready');

    self._joinCluster();
  });

  this.server.listen(this.port);
};

EpicCluster.prototype._updateClusterMap = function(nodeList) {
  this.nodeSweepNum++;

  for (var i = 0; i < nodeList.length; ++i) {
    if (nodeList[i].uuid === this.uuid) {
      continue;
    }

    var found = false;
    for (var j = 0; j < this.nodes.length; ++j) {
      if (this.nodes[j].uuid === nodeList[i].uuid) {
        this.nodes[j].sweepNum = this.nodeSweepNum;
        found = true;
        break;
      }
    }

    if (!found) {
      var socket = net.connect(nodeList[i].port, nodeList[i].host);
      var client = new _Client(this, nodeList[i].uuid, socket);
      client.sweepNum = this.nodeSweepNum;
      this.nodes.push(client);
    }
  }

  for (var k = 0; k < this.nodes.length; ++k) {
    if (this.nodes[k].sweepNum !== this.nodeSweepNum) {
      this.nodes[k].close();
    }
  }
};

EpicCluster.prototype._unregisterNode = function(client) {
  var clientIdx = this.nodes.indexOf(client);
  if (clientIdx < 0) {
    return;
  }
  this.nodes.splice(clientIdx, 1);
};

EpicCluster.prototype._joinCluster = function(retryCount, force) {
  var self = this;

  if (!retryCount) {
    retryCount = 0;
  }
  if (retryCount > 0 && !force) {
    setTimeout(function() {
      self._joinCluster(retryCount, true);
    }, retryCount * 1000);
    return;
  }

  var clusterKey = 'cluster-server';
  self.db.get(clusterKey, function(err, res) {
    var clusterList = [];
    var clusterCas = null;

    if (err) {
      if (err.code !== couchbase.errors.keyNotFound) {
        log.warn('cluster map retrieval failed', err);

        // Try again
        self._joinCluster(retryCount+1);
        return;
      } else {
        // This is okay, lets continue
      }
    } else {
      clusterList = res.value;
      clusterCas = res.cas;
    }

    // Current time in seconds
    var curTime = Math.floor((new Date()).getTime() / 1000);

    var newClusterList = [];
    for (var i = 0; i < clusterList.length; ++i) {
      if (curTime >= clusterList[i].expiry) {
        continue;
      }
      if (clusterList[i].uuid === self.uuid) {
        continue;
      }
      if (clusterList[i].host === self.host &&
          clusterList[i].port === self.port) {
        continue;
      }
      newClusterList.push(clusterList[i]);
    }

    newClusterList.push({
      uuid: self.uuid,
      host: self.host,
      port: self.port,
      expiry: curTime + 45
    });

    self._updateClusterMap(newClusterList);

    function __handleUpdate(err) {
      if (err) {
        if (err.code !== couchbase.errors.keyAlreadyExists) {
          log.warn('cluster map update failed', err);
          self._joinCluster(retryCount+1);
        } else {
          self._joinCluster(retryCount, true);
        }
        return;
      }

      // Saved successfully!  Start again
      setTimeout(function(){
        self._joinCluster();
      }, 30000);
    }
    if (clusterCas !== null) {
      self.db.replace(clusterKey, newClusterList, {cas: clusterCas}, __handleUpdate);
    } else {
      self.db.add(clusterKey, newClusterList, __handleUpdate);
    }
  });
};

EpicCluster.prototype._nemit = function(client, cmd, args) {
  var handlers = this.onMap[cmd];
  if (handlers) {
    for (var i = 0; i < handlers.length; ++i) {
      handlers[i](client, args);
    }
  }
};

EpicCluster.prototype.non = function(cmd, handler) {
  if (!this.onMap[cmd]) {
    this.onMap[cmd] = [];
  }
  this.onMap[cmd].push(handler);
};

EpicCluster.prototype.nemit = function(cmd, args) {
  for (var i = 0; i < this.nodes.length; ++i) {
    if (this.nodes[i].registered) {
      this.nodes[i].nemit(cmd, args);
    }
  }
};

module.exports = EpicCluster;