'use strict';

/**
 * VCall 后端联调测试（无第三方依赖）
 * 用法：node test/signaling.test.js [http://127.0.0.1:9002]
 */

const BASE = (process.argv[2] || process.env.VCALL_TEST_BASE || 'http://127.0.0.1:9002').replace(/\/$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws') + '/ws';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (detail ? ` -> ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeout = 4000, interval = 50) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

class Client {
  constructor(label) {
    this.label = label;
    this.messages = [];
    this.ws = null;
    this.closed = false;
  }

  async connect() {
    this.ws = new WebSocket(WS_BASE);
    this.ws.addEventListener('message', (event) => {
      try {
        this.messages.push(JSON.parse(event.data));
      } catch (err) {
        // ignore
      }
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label} 连接超时`)), 5000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`${this.label} 连接失败`));
      });
    });
    return this;
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  find(type) {
    return this.messages.find((m) => m.type === type);
  }

  async waitType(type, timeout = 4000) {
    return waitFor(() => this.find(type), timeout);
  }

  clear() {
    this.messages = [];
  }

  close() {
    try {
      this.ws.close();
    } catch (err) {
      // ignore
    }
  }
}

function jsonRequest(path, options = {}, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(BASE + path, { ...options, headers }).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => ({})),
    headers: res.headers,
  }));
}

async function main() {
  console.log(`\nVCall 后端测试 -> ${BASE}\n`);

  /* ---------------------------- HTTP 基础接口 ---------------------------- */
  console.log('[1] HTTP 基础接口');
  const health = await jsonRequest('/api/health');
  check('GET /api/health 返回 200', health.status === 200);
  check('健康检查包含版本号', Boolean(health.body.version), JSON.stringify(health.body));

  const config = await jsonRequest('/api/config');
  check('GET /api/config 返回 ICE 配置字段', Array.isArray(config.body.iceServers));
  check('配置包含单房间人数上限', typeof config.body.maxRoomMembers === 'number');

  const adminPage = await fetch(BASE + '/admin');
  const adminHtml = await adminPage.text();
  check('GET /admin 返回管理页面', adminPage.status === 200 && adminHtml.includes('VCall 管理后台'));

  const callPage = await fetch(BASE + '/call');
  check('GET /call 返回网页通话页', callPage.status === 200);

  const traversal = await fetch(BASE + '/../server/src/config.js');
  check('静态目录穿越被阻止', traversal.status === 404 || !(await traversal.text()).includes('adminPassword'));

  /* ------------------------------ 登录鉴权 ------------------------------ */
  console.log('\n[2] 管理登录与鉴权');
  const badLogin = await jsonRequest('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
  });
  check('错误密码返回 401', badLogin.status === 401);

  const login = await jsonRequest('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({
      username: process.env.VCALL_TEST_USER || 'admin',
      password: process.env.VCALL_TEST_PASS || 'vcall@2026',
    }),
  });
  check('正确密码登录成功', login.status === 200 && Boolean(login.body.token));
  const token = login.body.token;

  const noAuth = await jsonRequest('/api/admin/overview');
  check('未带令牌访问管理接口返回 401', noAuth.status === 401);

  const overview = await jsonRequest('/api/admin/overview', {}, token);
  check('管理概览接口可用', overview.status === 200 && typeof overview.body.overview.onlineDevices === 'number');

  /* ------------------------------ 信令流程 ------------------------------ */
  console.log('\n[3] WebSocket 信令');
  const a = await new Client('A').connect();
  const welcomeA = await a.waitType('welcome');
  check('连接后收到 welcome', Boolean(welcomeA && welcomeA.id));

  a.send({
    type: 'join',
    room: 'test-room-1',
    name: '手机A',
    device: { platform: 'android', model: 'Pixel', os: 'Android 13', appVersion: '1.0.0' },
  });
  const joinedA = await a.waitType('joined');
  check('加入房间成功', Boolean(joinedA && joinedA.room === 'test-room-1'));

  const b = await new Client('B').connect();
  await b.waitType('welcome');
  b.send({
    type: 'join',
    room: 'test-room-1',
    name: '电视B',
    device: { platform: 'android', model: 'MiTV', os: 'Android 9', appVersion: '1.0.0', isTv: true },
  });
  const joinedB = await b.waitType('joined');
  check('第二台设备加入成功', Boolean(joinedB));
  check('新成员能看到已有成员', Boolean(joinedB && joinedB.peers.length === 1 && joinedB.peers[0].name === '手机A'));

  const peerJoined = await a.waitType('peer-joined');
  check('已有成员收到 peer-joined', Boolean(peerJoined && peerJoined.peer.name === '电视B'));

  a.send({ type: 'offer', to: joinedB.self.id, sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' });
  const offer = await b.waitType('offer');
  check('offer 转发到对端', Boolean(offer && offer.from === joinedA.self.id && offer.sdp.includes('v=0')));

  b.send({ type: 'answer', to: joinedA.self.id, sdp: 'v=0\r\nanswer' });
  const answer = await a.waitType('answer');
  check('answer 回传给发起方', Boolean(answer && answer.sdp === 'v=0\r\nanswer'));

  a.send({ type: 'ice', to: joinedB.self.id, candidate: { candidate: 'candidate:1 1 udp 1 192.168.199.100 5000 typ host', sdpMid: '0' } });
  const ice = await b.waitType('ice');
  check('ICE 候选转发成功', Boolean(ice && ice.candidate.candidate.includes('192.168.199.100')));

  b.send({ type: 'state', muted: { audio: true, video: false } });
  const peerState = await a.waitType('peer-state');
  check('静音状态同步', Boolean(peerState && peerState.muted.audio === true));

  b.send({ type: 'stats', rtt: 42, bitrate: 1200000, width: 1280, height: 720, fps: 30 });
  await sleep(200);

  const rooms = await jsonRequest('/api/admin/rooms', {}, token);
  const room = (rooms.body.rooms || []).find((r) => r.id === 'test-room-1');
  check('管理端能看到房间与 2 个成员', Boolean(room && room.members.length === 2));
  check('管理端能看到通话状态', Boolean(room && room.inCall === true));
  check('管理端能看到媒体统计', Boolean(room && room.members.some((m) => m.stats && m.stats.rtt === 42)));

  const devices = await jsonRequest('/api/admin/devices', {}, token);
  check('管理端设备列表包含电视标记', Boolean((devices.body.devices || []).some((d) => d.isTv === true)));

  /* ------------------------------ 满员与踢人 ------------------------------ */
  console.log('\n[4] 房间上限与踢人');
  const c = await new Client('C').connect();
  await c.waitType('welcome');
  c.send({ type: 'join', room: 'test-room-1', name: '多余设备', device: { platform: 'android' } });
  const full = await c.waitType('error');
  check('房间满员时拒绝第三台设备', Boolean(full && full.code === 'room_full'), full && full.code);

  const kick = await jsonRequest(
    '/api/admin/rooms/test-room-1/kick',
    { method: 'POST', body: JSON.stringify({ peerId: joinedB.self.id }) },
    token
  );
  check('管理端踢人成功', kick.status === 200 && kick.body.ok === true);
  const kicked = await b.waitType('kicked');
  check('被踢设备收到 kicked 通知', Boolean(kicked));
  const left = await a.waitType('peer-left');
  check('对端收到 peer-left', Boolean(left && left.name === '电视B'));

  /* ------------------------------ 断开与清理 ------------------------------ */
  console.log('\n[5] 断开与数据清理');
  a.close();
  c.close();
  await sleep(500);

  const roomsAfter = await jsonRequest('/api/admin/rooms', {}, token);
  check('成员全部离开后房间被清理', !(roomsAfter.body.rooms || []).some((r) => r.id === 'test-room-1'));

  const metrics = await jsonRequest('/api/admin/metrics', {}, token);
  check('通话记录已归档', Array.isArray(metrics.body.history) && metrics.body.history.length >= 1);

  const logs = await jsonRequest('/api/admin/logs?limit=50', {}, token);
  check('日志接口可用且记录加入事件', Boolean((logs.body.logs || []).some((l) => l.message.includes('加入房间'))));

  const badJoin = await new Client('D').connect();
  await badJoin.waitType('welcome');
  badJoin.send({ type: 'join', room: '非法 房间!', name: 'X' });
  const badRoom = await badJoin.waitType('error');
  check('非法房间号被拒绝', Boolean(badRoom && badRoom.code === 'bad_room'));
  badJoin.close();

  await sleep(300);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) {
    console.log('失败项：');
    for (const item of failures) console.log('  - ' + item);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('测试异常终止：', err);
  process.exit(2);
});
