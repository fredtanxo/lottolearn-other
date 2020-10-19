const mediasoup = require('mediasoup');
const protoo = require('protoo-server');

const fs = require('fs');
const https = require('https');

const url = require('url');
const { AwaitQueue } = require('awaitqueue');
const Logger = require('./lib/Logger');
const Classroom = require('./lib/Classroom');

const config = require('./config');
const { numWorkers, workerSettings } = config.mediasoup;
const { listenIp, listenPort } = config.https;

const workers = [];
let signalServer = null; // 信令服务器
const rooms = new Map(); // 保存房间的Map (roomId, Classroom)
let workerPos = 0; // worker循环队列中当前指向的worker
const queue = new AwaitQueue();

// Loggers
const mainLogger = new Logger('main');
const workerLogger = new Logger('worker');
const serverLogger = new Logger('server')

// 运行 meaiasoup workers
mainLogger.info('Starting mediasoup workers...');
async function run() {
  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker(
      {
        logLevel: workerSettings.logLevel,
        logTags: workerSettings.logTags,
        rtcMinPort: Number(workerSettings.rtcMinPort),
        rtcMaxPort: Number(workerSettings.rtcMaxPort)
      }
    );

    worker.on('died', () => {
      mainLogger.error('mediasoup worker died, exiting... [%d]', worker.pid);
      process.exit(1);
    });

    workers.push(worker);

    setInterval(async () => {
      const usage = await worker.getResourceUsage();
      workerLogger.info('resource usage [pid:%d]: %o', worker.pid, usage)
    }, 120000);
  }
  mainLogger.info('Started %d mediasoup workers:', numWorkers);
  workers.forEach(worker => mainLogger.info(worker.pid));
}

run();


// 运行 protoo server
serverLogger.info('Starting protoo server...');
const tlsOptions = {
  cert: fs.readFileSync(config.https.cert),
  key: fs.readFileSync(config.https.key)
};
signalServer = new protoo.WebSocketServer(
  https.createServer(tlsOptions).listen(listenPort, listenIp),
  {
    maxReceivedFrameSize: 960000, // 960 KBytes.
    maxReceivedMessageSize: 960000,
    fragmentOutgoingMessages: true,
    fragmentationThreshold: 960000
  }
);
serverLogger.info('Started protoo server on port %d', listenPort);

signalServer.on('connectionrequest', async (info, accept, reject) => {
  const u = url.parse(info.request.url, true);
  const roomId = u.query['roomId'];
  const peerId = u.query['peerId'];
  if (!roomId || !peerId) {
    serverLogger.error('Connection request without roomId and/or peerId');
    reject(400, 'Connection request without roomId and/or peerId');
    return;
  }

  serverLogger.info(
    'connection [roomId: %s, peerId: %s, address: %s, origin: %s]',
    roomId, peerId, info.socket.remoteAddress, info.origin
  );

  // 使用awaitqueue防止多个用户同时请求同一个新房间
  queue.push(async () => {
    const room = await getRoom(roomId);
    rooms.set(roomId, room);
    const transport = accept();
    room.handleConnection(peerId, transport);
  });
});

async function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    const worker = getMediasoupWorker();
    room = await Classroom.create(worker, roomId);
    // 房间关闭后从Map中删除
    room.on('roomClose', () => rooms.delete(roomId));
  }
  return room;
}

function getMediasoupWorker() {
  const worker = workers[workerPos++];
  if (workerPos >= workers.length) {
    workerPos = 0;
  }
  return worker;
}
