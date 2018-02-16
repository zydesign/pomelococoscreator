require("protobuf");
require("protocol");
(function() {
  if(typeof(console.warn) === "undefined"){
    console.warn = cc.warn;
  }
  if(typeof(console.error) === "undefined"){
    console.error = cc.error;
  }
  var JS_WS_CLIENT_TYPE = 'js-websocket';
  var JS_WS_CLIENT_VERSION = '0.0.1';

  var Protocol = window.Protocol;
  var protobuf = window.protobuf;
  var decodeIO_protobuf = window.decodeIO_protobuf;
  var decodeIO_encoder = null;
  var decodeIO_decoder = null;
  var Package = Protocol.Package;
  var Message = Protocol.Message;
  var EventEmitter = require("events");
  var rsa = window.rsa;

  if(typeof(window) != "undefined" && typeof(sys) != 'undefined' && sys.localStorage) {
    window.localStorage = sys.localStorage;
  }
  
  var RES_OK = 200;
  var RES_FAIL = 500;
  var RES_OLD_CLIENT = 501;

  if (typeof Object.create !== 'function') {
    Object.create = function (o) {
      function F() {}
      F.prototype = o;
      return new F();
    };
  }

  var root = window;
  var pomelo = Object.create(EventEmitter.prototype); // object extend from object
  root.pomelo = pomelo;
  var socket = null;
  var reqId = 0;
  var callbacks = {};
  var handlers = {};
  //Map from request id to route
  var routeMap = {};
  var dict = {};    // route string to code
  var abbrs = {};   // code to route string
  var serverProtos = {};
  var clientProtos = {};
  var protoVersion = 0;

  var heartbeatInterval = 0;
  var heartbeatTimeout = 0;
  var nextHeartbeatTimeout = 0;
  var gapThreshold = 100;   // heartbeat gap threashold
  var heartbeatId = null;
  var heartbeatTimeoutId = null;
  var handshakeCallback = null;

  var decode = null;
  var encode = null;

  var reconnect = false;                     //重连开关
  var reconncetTimer = null;                 //重连时间
  var reconnectUrl = null;                   //重连地址
  var reconnectAttempts = 0;                 //初始重连次数0
  var reconnectionDelay = 5000;              //重连事件间隔：5秒
  var DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;   //重连最大次数：默认10次

  var useCrypto;

  var handshakeBuffer = {
    'sys': {
      type: JS_WS_CLIENT_TYPE,
      version: JS_WS_CLIENT_VERSION,
      rsa: {}
    },
    'user': {
    }
  };

  //非官方函数
  /**
   * @return {bool} true正常回调, false不再调用rpc的回调函数
   */
  var filterAfter = function(data){
    return true;
  }

  pomelo.setFilterAfter = function(cb){
    filterAfter = cb;
  }
  // 非官方函数结束

  var initCallback = null;

  //init连接网络。params：{host：host, port：port, reconnect:true, }
  pomelo.init = function(params, cb) {
    initCallback = cb;
    var host = params.host;
    var port = params.port;

    encode = params.encode || defaultEncode;
    decode = params.decode || defaultDecode;

    var url = 'ws://' + host;
    if(port) {
      url +=  ':' + port;
    }

    handshakeBuffer.user = params.user;
    if(params.encrypt) {
      useCrypto = true;
      rsa.generate(1024, "10001");
      var data = {
        rsa_n: rsa.n.toString(16),
        rsa_e: rsa.e
      }
      handshakeBuffer.sys.rsa = data;
    }
    handshakeCallback = params.handshakeCallback;
    connect(params, url, cb);
  };

  var defaultDecode = pomelo.decode = function(data) {
    //probuff decode
    var msg = Message.decode(data);

    if(msg.id > 0){
      msg.route = routeMap[msg.id];
      delete routeMap[msg.id];
      if(!msg.route){
        return;
      }
    }

    msg.body = deCompose(msg);
    return msg;
  };

  var defaultEncode = pomelo.encode = function(reqId, route, msg) {
    var type = reqId ? Message.TYPE_REQUEST : Message.TYPE_NOTIFY;

    //compress message by protobuf
    if(protobuf && clientProtos[route]) {
      msg = protobuf.encode(route, msg);
    } else if(decodeIO_encoder && decodeIO_encoder.lookup(route)) {
      var Builder = decodeIO_encoder.build(route);
      msg = new Builder(msg).encodeNB();
    } else {
      msg = Protocol.strencode(JSON.stringify(msg));
    }

    var compressRoute = 0;
    if(dict && dict[route]) {
      route = dict[route];
      compressRoute = 1;
    }

    return Message.encode(reqId, type, compressRoute, route, msg);
  };

  var connect = function(params, url, cb) {
    console.log('connect to ' + url);

    var params = params || {};
    //最大尝试重连次数（1.init的时候maxReconnectAttempts：N。）默认10次
    var maxReconnectAttempts = params.maxReconnectAttempts || DEFAULT_MAX_RECONNECT_ATTEMPTS;
    //重连的网址
    reconnectUrl = url;
    //Add protobuf version
    //数据传输版本
    if(window.localStorage && window.localStorage.getItem('protos') && protoVersion === 0) {
      var protos = JSON.parse(window.localStorage.getItem('protos'));

      protoVersion = protos.version || 0;
      serverProtos = protos.server || {};
      clientProtos = protos.client || {};

      if(!!protobuf) {
        protobuf.init({encoderProtos: clientProtos, decoderProtos: serverProtos});
      } 
      if(!!decodeIO_protobuf) {
        decodeIO_encoder = decodeIO_protobuf.loadJson(clientProtos);
        decodeIO_decoder = decodeIO_protobuf.loadJson(serverProtos);
      }
    }
    //Set protoversion
    handshakeBuffer.sys.protoVersion = protoVersion;

    //连接成功函数
    var onopen = function(event) {
      //如果该连接成功为重连成功，发射'重连'事件
      if(!!reconnect) {
        pomelo.emit('reconnect');
      }
      reset();
      var obj = Package.encode(Package.TYPE_HANDSHAKE, Protocol.strencode(JSON.stringify(handshakeBuffer)));
      send(obj);
    };
    //收到消息时，触发的函数
    var onmessage = function(event) {
      processPackage(Package.decode(event.data), cb);
      // new package arrived, update the heartbeat timeout
      if(heartbeatTimeout) {
        nextHeartbeatTimeout = Date.now() + heartbeatTimeout;
      }
    };
    //连接失败、请求失败，接收失败，发送数据失败时，触发该函数
    var onerror = function(event) {
      //重连失败，发射'连接错误'事件
      pomelo.emit('io-error', event);
      console.error('socket error: ', event);
    };
    //网络中断，触发该函数
    var onclose = function(event) {
      pomelo.emit('close',event);
      //发射'断开连接'事件
      pomelo.emit('disconnect', event);
      console.error('socket close: ', event);
      //如果init提供参数：renconnect：true； 而且重连次数小于最大值,执行connect
      if(!!params.reconnect && reconnectAttempts < maxReconnectAttempts) {
        reconnect = true;                          //重连开启
        reconnectAttempts++;                       //重连次数+1
        reconncetTimer = setTimeout(function() {   //5秒后，执行connect(params, reconnectUrl, cb)
          connect(params, reconnectUrl, cb);
        }, reconnectionDelay);
        reconnectionDelay *= 2;                    //再等待10秒
      }
    };
    socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = onopen;
    socket.onmessage = onmessage;
    socket.onerror = onerror;
    socket.onclose = onclose;
  };

  pomelo.disconnect = function() {
    if(socket) {
      if(socket.disconnect) socket.disconnect();
      if(socket.close) socket.close();
      console.log('disconnect');
      socket = null;
    }

    if(heartbeatId) {
      clearTimeout(heartbeatId);
      heartbeatId = null;
    }
    if(heartbeatTimeoutId) {
      clearTimeout(heartbeatTimeoutId);
      heartbeatTimeoutId = null;
    }
  };

  //重连成功后，重设重连参数
  var reset = function() {
    reconnect = false;
    reconnectionDelay = 1000 * 5;
    reconnectAttempts = 0;
    clearTimeout(reconncetTimer);
  };

  pomelo.request = function(route, msg, cb) {
    if(arguments.length === 2 && typeof msg === 'function') {
      cb = msg;
      msg = {};
    } else {
      msg = msg || {};
    }
    route = route || msg.route;
    if(!route) {
      return;
    }
    pomelo.emit('beforeRPC');
    reqId++;
    sendMessage(reqId, route, msg);

    callbacks[reqId] = cb;
    routeMap[reqId] = route;
  };

  pomelo.notify = function(route, msg) {
    msg = msg || {};
    sendMessage(0, route, msg);
  };

  var sendMessage = function(reqId, route, msg) {
    if(useCrypto) {
      msg = JSON.stringify(msg);
      var sig = rsa.signString(msg, "sha256");
      msg = JSON.parse(msg);
      msg['__crypto__'] = sig;
    }

    if(encode) {
      msg = encode(reqId, route, msg);
    }

    var packet = Package.encode(Package.TYPE_DATA, msg);
    send(packet);
  };

  var send = function(packet) {
    if(socket)
      socket.send(packet.buffer);
  };

  var handler = {};

  var heartbeat = function(data) {
    if(!heartbeatInterval) {
      // no heartbeat
      return;
    }

    var obj = Package.encode(Package.TYPE_HEARTBEAT);
    if(heartbeatTimeoutId) {
      clearTimeout(heartbeatTimeoutId);
      heartbeatTimeoutId = null;
    }

    if(heartbeatId) {
      // already in a heartbeat interval
      return;
    }
    heartbeatId = setTimeout(function() {
      heartbeatId = null;
      send(obj);

      nextHeartbeatTimeout = Date.now() + heartbeatTimeout;
      heartbeatTimeoutId = setTimeout(heartbeatTimeoutCb, heartbeatTimeout);
    }, heartbeatInterval);
  };

  var heartbeatTimeoutCb = function() {
    var gap = nextHeartbeatTimeout - Date.now();
    if(gap > gapThreshold) {
      heartbeatTimeoutId = setTimeout(heartbeatTimeoutCb, gap);
    } else {
      console.error('server heartbeat timeout');
      pomelo.emit('heartbeat timeout');
      pomelo.disconnect();
    }
  };

  var handshake = function(data) {
    data = JSON.parse(Protocol.strdecode(data));
    if(data.code === RES_OLD_CLIENT) {
      pomelo.emit('error', 'client version not fullfill');
      return;
    }

    if(data.code !== RES_OK) {
      pomelo.emit('error', 'handshake fail');
      return;
    }

    handshakeInit(data);

    var obj = Package.encode(Package.TYPE_HANDSHAKE_ACK);
    send(obj);
    if(initCallback) {
      initCallback(socket);
    }
  };

  var onData = function(data) {
    var msg = data;
    if(decode) {
      msg = decode(msg);
    }
    processMessage(pomelo, msg);
  };

  var onKick = function(data) {
    data = JSON.parse(Protocol.strdecode(data));
    pomelo.emit('onKick', data);
  };

  handlers[Package.TYPE_HANDSHAKE] = handshake;
  handlers[Package.TYPE_HEARTBEAT] = heartbeat;
  handlers[Package.TYPE_DATA] = onData;
  handlers[Package.TYPE_KICK] = onKick;

  var processPackage = function(msgs) {
    if(Array.isArray(msgs)) {
      for(var i=0; i<msgs.length; i++) {
        var msg = msgs[i];
        handlers[msg.type](msg.body);
      }
    } else {
      handlers[msgs.type](msgs.body);
    }
  };

  var processMessage = function(pomelo, msg) {
    if(!msg.id) {
      // server push message
      pomelo.emit(msg.route, msg.body);
      return;
    }

    //if have a id then find the callback function with the request
    var cb = callbacks[msg.id];

    delete callbacks[msg.id];
    if(typeof cb !== 'function') {
      return;
    }
    pomelo.emit("afterRPC");
    if(filterAfter(msg.body)){
        cb(msg.body);
    }
    return;
  };

  var processMessageBatch = function(pomelo, msgs) {
    for(var i=0, l=msgs.length; i<l; i++) {
      processMessage(pomelo, msgs[i]);
    }
  };

  var deCompose = function(msg) {
    var route = msg.route;

    //Decompose route from dict
    if(msg.compressRoute) {
      if(!abbrs[route]){
        return {};
      }

      route = msg.route = abbrs[route];
    }
    if(protobuf && serverProtos[route]) {
      return protobuf.decodeStr(route, msg.body);
    } else if(decodeIO_decoder && decodeIO_decoder.lookup(route)) {
      return decodeIO_decoder.build(route).decode(msg.body);
    } else {
      return JSON.parse(Protocol.strdecode(msg.body));
    }

  };

  var handshakeInit = function(data) {
    if(data.sys && data.sys.heartbeat) {
      heartbeatInterval = data.sys.heartbeat * 1000;   // heartbeat interval
      heartbeatTimeout = heartbeatInterval * 2;        // max heartbeat timeout
    } else {
      heartbeatInterval = 0;
      heartbeatTimeout = 0;
    }

    initData(data);

    if(typeof handshakeCallback === 'function') {
      handshakeCallback(data.user);
    }
  };

  //Initilize data used in pomelo client
  var initData = function(data) {
    if(!data || !data.sys) {
      return;
    }
    dict = data.sys.dict;
    var protos = data.sys.protos;

    //Init compress dict
    if(dict) {
      dict = dict;
      abbrs = {};

      for(var route in dict) {
        abbrs[dict[route]] = route;
      }
    }

    //Init protobuf protos
    if(protos) {
      protoVersion = protos.version || 0;
      serverProtos = protos.server || {};
      clientProtos = protos.client || {};

        //Save protobuf protos to localStorage
        window.localStorage.setItem('protos', JSON.stringify(protos));

        if(!!protobuf) {
          protobuf.init({encoderProtos: protos.client, decoderProtos: protos.server});
        }
        if(!!decodeIO_protobuf) {
          decodeIO_encoder = decodeIO_protobuf.loadJson(clientProtos);
          decodeIO_decoder = decodeIO_protobuf.loadJson(serverProtos);
        }
      }
    };

    module.exports = pomelo;
  })();
