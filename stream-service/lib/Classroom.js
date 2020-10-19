const Logger = require('./Logger');
const protoo = require('protoo-server');

const config = require('../config');

// 简单起见，直接继承protoo.Room，保存router和处理消息
class Classroom extends protoo.Room {
  static async create(worker, roomId) {
    const { mediaCodecs } = config.mediasoup.routerOptions;
    const router = await worker.createRouter({ mediaCodecs });
    return new Classroom(router, roomId);
  }

  constructor(router, roomId) {
    super();
    this.router = router; // mediasoup的router
    this.isClosed = false; // 该聊天室是否已关闭
    this.roomId = roomId; // 房间ID
    this.startTime = Date.now();
    this.logger = new Logger(`room[${this.roomId}]`);
    this.logger.info('Room created');
  }

  // 关闭房间，触发`roomClose`事件，index.js中的room则被相应清除
  closeRoom() {
    this.safeEmit('roomClose');
    this.isClosed = true;
    this.router.close();
    this.close();
    const endTime = Date.now();
    this.logger.info('Room closed. Opened for %d seconds', (endTime - this.startTime) / 1000);
  }

  // 处理protoo-client传来的消息
  handleConnection(peerId, transport) {
    // 一个peer只能有一台设备加入聊天室
    const existingPeer = this.getPeer(peerId);
    if (existingPeer) {
      existingPeer.close();
    }

    const peer = this.createPeer(peerId, transport);
    // peer.data不能直接赋值，只能一项一项设置
    // peer状态
    peer.data.joined = false, // 是否已加入
    peer.data.nickname = undefined, // peer在聊天室的昵称
    peer.data.avatar = undefined, // peer在聊天室的头像
    peer.data.rtpCapabilities = undefined,
    peer.data.sctpCapabilities = undefined,
    // mediasoup
    peer.data.transports = new Map(), // (transportId, transport)
    peer.data.producers = new Map(), // (producerId, producer)
    peer.data.consumers = new Map(), // (consumerId, consumer)

    // 处理peer发出的请求
    peer.on('request', (request, accept, reject) => {
      switch (request.method) {
      case 'getRouterRtpCapabilities':
        accept(this.router.rtpCapabilities);
        this.logger.debug('Accepted request from peer %s: %o', peer.id, request);
        break;
      case 'createWebRtcTransport':
        this.handleCreateWebRtcTransport(peer, request, accept, reject);
        break;
      case 'join':
        this.handleJoin(peer, request, accept, reject);
        break;
      case 'connectWebRtcTransport':
        this.handleConnectWebRtcTransport(peer, request, accept, reject);
        break;
      case 'produce':
        this.handleProduce(peer, request, accept, reject);
        break;
      case 'produceData':
        this.handleProduceData(peer, request, accept, reject);
        break;
      case 'pauseProducer':
        this.handlePauseProducer(peer, request, accept, reject);
        break;
      case 'pauseConsumer':
        this.handlePauseConsumer(peer, request, accept, reject);
        break;
      case 'resumeProducer':
        this.handleResumeProducer(peer, request, accept, reject);
        break;
      case 'resumeConsumer':
        this.handleResumeConsumer(peer, request, accept, reject);
        break;
      case 'closeProducer':
        this.handleCloseProducer(peer, request, accept, reject);
        break;
      }
    });

    // peer离开聊天室
    peer.on('close', () => {
      if (this.isClosed) {
        return;
      }
      // 通知其他peer这个用户下线了
      const joinedPeers = this.peers.filter(joinedPeer => joinedPeer != peer);
      for (const joinedPeer of joinedPeers) {
        joinedPeer.notify('peerClosed', { peerId: peer.id });
      }
      // 关闭当前peer的所有transport
      for (const transport of peer.data.transports.values()) {
        transport.close();
      }
      // 若聊天室没其他人则关闭聊天室
      if (this.peers.length === 0) {
        this.closeRoom();
      }

      this.logger.debug('Peer %s closed', peer.id);
    });
  }

  async handleCreateWebRtcTransport(peer, request, accept, reject) {
    const {
      forceTcp,
      producing,
      consuming,
      sctpCapabilities
    } = request.data;

    const webRtcTransportOptions = {
      ...config.mediasoup.webRtcTransportOptions,
      enableSctp: Boolean(sctpCapabilities),
      numSctpStreams: (sctpCapabilities || {}).numStreams,
      appData: { producing, consuming }
    };

    if (forceTcp) {
        webRtcTransportOptions.enableUdp = false;
        webRtcTransportOptions.enableTcp = true;
    }

    const transport = await this.router.createWebRtcTransport(webRtcTransportOptions);
    peer.data.transports.set(transport.id, transport);

    accept({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters
    });

    const { maxIncomingBitrate } = config.mediasoup.webRtcTransportOptions;

    if (maxIncomingBitrate) {
      await transport.setMaxIncomingBitrate(maxIncomingBitrate);
    }

    this.logger.debug('Created WebRTC transport for peer %s: %o', peer.id, request.data);
  }

  // peer 加入房间
  handleJoin(peer, request, accept, reject) {
    // 如果已经加入，拒绝加入
    if (peer.data.joined) {
      reject();
      return;
    }

    const {
      nickname,
      avatar, 
      rtpCapabilities,
      sctpCapabilities
    } = request.data;

    peer.data.joined = true;
    peer.data.nickname = nickname;
    peer.data.avatar = avatar;
    peer.data.rtpCapabilities = rtpCapabilities;
    peer.data.sctpCapabilities = sctpCapabilities;

    // 已经在房间的peers
    const joinedPeers = this.peers.filter(
      joinedPeer => joinedPeer.data.joined && joinedPeer.id !== peer.id
    );

    const peerInfos = joinedPeers.map(joinedPeer => ({
        id:       joinedPeer.id,
        nickname: joinedPeer.data.nickname,
        avatar:   joinedPeer.data.avatar
      }));

    accept({ peers: peerInfos });

    for (const joinedPeer of joinedPeers) {
      // consume已经在produce的peers
      for (const producer of joinedPeer.data.producers.values()) {
        this.createConsumer({
          consumerPeer: peer,
          producerPeer: joinedPeer,
          producer
        });
      }
      // 通知其他peer该peer上线
      joinedPeer.notify('newPeer', {
        id:       peer.id,
        nickname: peer.data.nickname,
        avatar:   peer.data.avatar
      });
    }

    this.logger.debug('Peer %s joined room with peers: %o', peer.id, joinedPeers);
  }

  async createConsumer({ consumerPeer, producerPeer, producer }) {
    // 判断是否能consume
    if (!consumerPeer.data.rtpCapabilities ||
      !this.router.canConsume({
        producerId: producer.id,
        rtpCapabilities: consumerPeer.data.rtpCapabilities
    })) {
      this.logger.error('Can not consume %s for peer %s', producerPeer.id, consumerPeer.id);
      return;
    }

    // 寻找正在consume的transport
    const transport = Array.from(consumerPeer.data.transports.values())
      .find(t => t.appData.consuming);

    if (!transport) {
      this.logger.warn(
        'Peer %s is supposed to consume but with no consuming transports',
        consumerPeer.id
      );
      return;
    }

    const consumer = await transport.consume({
      producerId:       producer.id,
      rtpCapabilities:  consumerPeer.data.rtpCapabilities,
      paused:           true // 官方建议先创建paused的transport，等待客户端就绪再请求resume
    });
    consumerPeer.data.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => {
      consumerPeer.data.consumers.delete(consumer.id);
    });
    consumer.on('producerclose', () => {
      consumerPeer.data.consumers.delete(consumer.id);
      consumerPeer.notify('consumerClosed', {
        consumerId: consumer.id,
        peerId: producerPeer.id
      });
    });
    consumer.on('producerpause', () => {
      consumerPeer.notify('consumerPaused', {
        consumerId: consumer.id,
        peerId: producerPeer.id
      });
    });
    consumer.on('producerresume', () => {
      consumerPeer.notify('consumerResumed', {
        consumerId: consumer.id,
        peerId: producerPeer.id
      });
    });

    await consumerPeer.request('newConsumer', {
      peerId:         producerPeer.id,
      producerId:     producer.id,
      id:             consumer.id,
      kind:           consumer.kind,
      rtpParameters:  consumer.rtpParameters,
      type:           consumer.type,
      appData:        producer.appData,
      producerPaused: consumer.producerPaused
    });

    // 客户端就绪，resume
    await consumer.resume();
    consumerPeer.notify('consumerResumed', { consumerId: consumer.id });

    this.logger.debug('Resumed %s comsumer for peer %s', consumer.kind, consumerPeer.id);
  }

  // 客户端连接到transport
  async handleConnectWebRtcTransport(peer, request, accept, reject) {
    const { transportId, dtlsParameters } = request.data;
    const transport = peer.data.transports.get(transportId);

    await transport.connect({ dtlsParameters });

    accept();

    this.logger.debug('Peer %s connected to WebRTCTransport', peer.id);
  }

  // 客户端produce
  async handleProduce(peer, request, accept, reject) {
    if (!peer.data.joined) {
      reject();
    }

    const { transportId, kind, rtpParameters } = request.data;
    let { appData } = request.data;
    const transport = peer.data.transports.get(transportId);
    appData = { ...appData, peerId: peer.id };

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData
    });
    peer.data.producers.set(producer.id, producer);

    accept({ id: producer.id });

    const joinedPeers = this.peers.filter(
      joinedPeer => joinedPeer.data.joined && joinedPeer.id !== peer.id
    );
    // 通知其他peers去consume
    for (const joinedPeer of joinedPeers) {
      this.createConsumer({
        consumerPeer: joinedPeer,
        producerPeer: peer,
        producer
      });
    }

    this.logger.debug('Peer %s produce %s', peer.id, producer.kind);
  }

  // 暂停produce
  async handlePauseProducer(peer, request, accept, reject) {
    if (!peer.data.joined) {
      reject();
    }
    const { producerId } = request.data;
    const producer = peer.data.producers.get(producerId);

    await producer.pause();

    accept();

    this.logger.debug('Peer %s pause %s produce', peer.id, producer.kind);
  }

  // 暂停consume，前端分页用到
  async handlePauseConsumer(peer, request, accept, reject) {
    if (!peer.data.joined) {
      reject();
    }

    const { consumerId } = request.data;
    const consumer = peer.data.consumers.get(consumerId);

    await consumer.pause();

    accept();

    this.logger.debug('Peer %s pause %s comsume', peer.id, consumer.kind);
  }

  // 继续produce
  async handleResumeProducer(peer, request, accept, reject) {
    if (!peer.data.joined) {
      reject();
    }

    const { producerId } = request.data;
    const producer = peer.data.producers.get(producerId);

    await producer.resume();

    accept();

    this.logger.debug('Peer %s resume %s produce', peer.id, producer.kind);
  }

  // 继续consume
  async handleResumeConsumer(peer, request, accept, reject) {
    if (!peer.data.joined) {
      reject();
    }

    const { consumerId } = request.data;
    const consumer = peer.data.consumers.get(consumerId);

    await consumer.resume();

    accept();

    this.logger.debug('Peer %s resume %s comsume', peer.id, consumer.kind);
  }

  // 停止produce
  async handleCloseProducer(peer, request, accept, reject) {
    if (!peer.data.joined) {
      reject();
    }

    const { producerId } = request.data;
    const producer = peer.data.producers.get(producerId);

    await producer.close();
    peer.data.producers.delete(producer.id);

    accept();

    this.logger.debug('Peer %s close %s produce', peer.id, producer.kind);
  }
}

module.exports = Classroom;
