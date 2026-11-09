'use strict';

/**
 * VCall v2 联调测试：终端注册 -> 通讯录 -> 呼叫 -> 多人 -> 管理接口
 * 用法：node test/signaling.test.js [http://127.0.0.1:9002]
 */

const BASE = (process.argv[2] || process.env.VCALL_TEST_BASE || 'http://127.0.0.1:9002').replace(/\/$/, '');
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  PASS ' + name);
  } else {
    failed += 1;
    failures.push(name + (detail ? ' -> ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? ' -> ' + detail : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 5000, interval = 50) {
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
    this.ws = new WebSocket(WS_URL);
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
      const timer = setTimeout(() => reject(new Error(this.label + ' 连接超时')), 5000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(this.label + ' 连接失败'));
      });
    });
    return this;
  }

  async register(name, device) {
    this.ws.send(JSON.stringify({ type: 'register', name, device: device || { platform: 'test' } }));
    const registered = await this.waitType('registered');
    return registered && registered.self;
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  find(type) {
    return this.messages.find((m) => m.type === type);
  }

  findAll(type) {
    return this.messages.filter((m) => m.type === type);
  }

  async waitType(type, timeout = 5000) {
    return waitFor(() => this.find(type), timeout);
  }

  async waitDirectoryContains(terminalId, timeout = 5000) {
    return waitFor(
      () => this.findAll('directory').find((d) => (d.terminals || []).some((t) => t.id === terminalId)),
      timeout
    );
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
  if (token) headers.Authorization = 'Bearer ' + token;
  return fetch(BASE + path, { ...options, headers }).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => ({})),
  }));
}

async function main() {
  console.log('\nVCall v2 测试 -> ' + BASE + '\n');

  console.log('[1] HTTP 与静态资源');
  const health = await jsonRequest('/api/health');
  check('健康检查 200', health.status === 200);

  const config = await jsonRequest('/api/config');
  check('配置返回单次通话上限', typeof config.body.maxCallMembers === 'number');

  const adminPage = await fetch(BASE + '/admin/');
  check('管理后台可访问', adminPage.status === 200 && (await adminPage.text()).includes('VCall 管理后台'));

  const callPage = await fetch(BASE + '/call/');
  const callHtml = await callPage.text();
  check('网页端为通讯录模式', callPage.status === 200 && callHtml.includes('进入通讯录'));

  console.log('\n[2] 管理登录');
  const login = await jsonRequest('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'vcall@2026' }),
  });
  check('管理登录成功', login.status === 200 && Boolean(login.body.token));
  const token = login.body.token;

  console.log('\n[3] 终端注册与通讯录');
  const a = await new Client('A').connect();
  const welcomeA = await a.waitType('welcome');
  check('连接后收到 welcome', Boolean(welcomeA && welcomeA.id));
  const selfA = await a.register('手机A', { platform: 'android', model: 'Pixel', isTv: false });
  check('终端 A 注册成功', Boolean(selfA && selfA.id));

  const b = await new Client('B').connect();
  await b.waitType('welcome');
  const selfB = await b.register('电视B', { platform: 'android', model: 'MiTV', isTv: true });
  check('终端 B 注册成功', Boolean(selfB && selfB.id));

  const dirA = await a.waitDirectoryContains(selfB.id);
  check('A 的通讯录中出现 B', Boolean(dirA));
  const dirB = await b.waitDirectoryContains(selfA.id);
  check('B 的通讯录中出现 A', Boolean(dirB));

  const terminals = await jsonRequest('/api/admin/terminals', {}, token);
  check('管理端终端列表包含两台', (terminals.body.terminals || []).length >= 2);

  console.log('\n[4] 一对一呼叫');
  a.send({ type: 'call-invite', targets: [selfB.id], video: true });
  const created = await a.waitType('call-created');
  check('A 收到 call-created', Boolean(created && created.callId));
  const callId = created.callId;

  const incoming = await b.waitType('call-incoming');
  check('B 收到来电', Boolean(incoming && incoming.callId === callId));

  b.send({ type: 'call-accept', callId });
  const joined = await b.waitType('call-joined');
  check('B 收到 call-joined 且含 A', Boolean(joined && joined.members.some((m) => m.id === selfA.id)));

  const memberJoined = await a.waitType('call-member-joined');
  check('A 收到成员加入通知', Boolean(memberJoined && memberJoined.member.id === selfB.id));

  a.send({ type: 'offer', to: selfB.id, callId, sdp: 'v=0\r\noffer' });
  const offer = await b.waitType('offer');
  check('offer 转发成功', Boolean(offer && offer.from === selfA.id));

  b.send({ type: 'answer', to: selfA.id, callId, sdp: 'v=0\r\nanswer' });
  const answer = await a.waitType('answer');
  check('answer 转发成功', Boolean(answer && answer.sdp.includes('answer')));

  b.send({ type: 'ice', to: selfA.id, callId, candidate: { candidate: 'candidate:1 1 udp 1 192.168.199.100 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
  const ice = await a.waitType('ice');
  check('ICE 转发成功', Boolean(ice && ice.candidate.candidate.includes('192.168.199.100')));

  const calls = await jsonRequest('/api/admin/calls', {}, token);
  const callInfo = (calls.body.calls || []).find((c) => c.id === callId);
  check('管理端看到进行中通话', Boolean(callInfo && callInfo.members.length === 2));

  console.log('\n[5] 多人通话');
  const c = await new Client('C').connect();
  await c.waitType('welcome');
  const selfC = await c.register('手机C', { platform: 'android' });
  await a.waitDirectoryContains(selfC.id);

  a.clear();
  a.send({ type: 'call-invite', targets: [selfC.id], video: true });
  const busyError = await a.waitType('error');
  check('通话中不能再次发起呼叫', Boolean(busyError && busyError.code === 'busy'));

  console.log('\n[5] 第三方随时加入通话');
  c.clear();
  c.send({ type: 'call-invite', targets: [selfA.id], video: true });
  const cJoined = await c.waitType('call-joined');
  check('第三方加入进行中的通话', Boolean(cJoined && cJoined.members.some((m) => m.id === selfA.id)));
  const aSawC = await waitFor(
    () => a.findAll('call-member-joined').find((m) => m.member.id === selfC.id),
    4000
  );
  check('原成员收到新成员加入', Boolean(aSawC));

  console.log('\n[6] 离开与结束');
  c.send({ type: 'call-leave', callId: cJoined.callId });
  await sleep(200);
  b.send({ type: 'call-leave', callId });
  const left = await waitFor(
    () => a.findAll('call-member-left').find((m) => m.id === selfB.id),
    4000
  );
  check('A 收到成员离开', Boolean(left));
  const ended = await a.waitType('call-ended');
  check('剩余 1 人时通话结束', Boolean(ended));

  const terminalsAfter = await jsonRequest('/api/admin/terminals', {}, token);
  const stateA = (terminalsAfter.body.terminals || []).find((t) => t.id === selfA.id);
  check('通话结束后终端回到空闲', Boolean(stateA && stateA.state === 'idle'));

  console.log('\n[7] 拒绝与多人群呼');
  c.clear();
  const d = await new Client('D').connect();
  await d.waitType('welcome');
  const selfD = await d.register('手机D', { platform: 'android' });
  await c.waitDirectoryContains(selfD.id);

  c.send({ type: 'call-invite', targets: [selfD.id], video: true });
  const cCreated = await c.waitType('call-created');
  const dIncoming = await d.waitType('call-incoming');
  check('D 收到来电', Boolean(dIncoming));
  d.send({ type: 'call-reject', callId: cCreated.callId });
  const rejected = await c.waitType('call-rejected');
  check('C 收到拒绝通知', Boolean(rejected && rejected.id === selfD.id));

  const e = await new Client('E').connect();
  await e.waitType('welcome');
  const selfE = await e.register('电视E', { platform: 'android', isTv: true });
  await c.waitDirectoryContains(selfE.id);

  c.clear();
  d.clear();
  c.send({ type: 'call-invite', targets: [selfD.id, selfE.id], video: true });
  const groupCreated = await c.waitType('call-created');
  check('发起多人呼叫', Boolean(groupCreated && groupCreated.invited.length === 2));
  const groupCallId = groupCreated.callId;

  const dGroup = await d.waitType('call-incoming');
  check('群呼中 D 收到来电且标记为多人', Boolean(dGroup && dGroup.group === true));

  d.send({ type: 'call-accept', callId: groupCallId });
  await d.waitType('call-joined');
  e.send({ type: 'call-accept', callId: groupCallId });
  const eJoined = await e.waitType('call-joined');
  check('E 加入后能看到已有成员', Boolean(eJoined && eJoined.members.length === 2));

  const dSawE = await waitFor(
    () => d.findAll('call-member-joined').find((m) => m.member.id === selfE.id),
    4000
  );
  check('D 收到 E 加入通知', Boolean(dSawE));

  c.send({ type: 'call-leave', callId: groupCallId });
  const dLeft = await waitFor(
    () => d.findAll('call-member-left').find((m) => m.id === selfC.id),
    4000
  );
  check('C 离开后 D 收到通知', Boolean(dLeft));

  console.log('\n[8] 管理端下线终端');
  const kick = await jsonRequest('/api/admin/terminals/' + encodeURIComponent(selfE.id) + '/kick', {
    method: 'POST',
    body: '{}',
  }, token);
  check('管理员下线终端成功', kick.status === 200 && kick.body.ok === true);
  const kicked = await e.waitType('kicked');
  check('被下线终端收到通知', Boolean(kicked));

  a.close();
  b.close();
  c.close();
  d.close();
  e.close();
  await sleep(500);

  console.log('\n[9] 公告推送与通话设置');
  const f = await new Client('F').connect();
  await f.waitType('welcome');
  await f.register('手机F', { platform: 'android' });

  const push = await jsonRequest('/api/admin/announcement', {
    method: 'POST',
    body: JSON.stringify({ text: '测试公告-立即推送' }),
  }, token);
  check('公告推送接口成功', push.status === 200 && push.body.ok === true);
  check('返回在线终端数量', typeof push.body.online === 'number');
  const announcement = await f.waitType('announcement');
  check('在线终端收到公告推送', Boolean(announcement && announcement.text === '测试公告-立即推送'));

  const limits = await jsonRequest('/api/admin/limits', {
    method: 'POST',
    body: JSON.stringify({ maxCallMembers: 4 }),
  }, token);
  check('保存人数上限成功', limits.status === 200 && limits.body.maxCallMembers === 4);
  const cfg = await jsonRequest('/api/config');
  check('人数上限立即生效', cfg.body.maxCallMembers === 4);

  const invalid = await jsonRequest('/api/admin/limits', {
    method: 'POST',
    body: JSON.stringify({ maxCallMembers: 99 }),
  }, token);
  check('非法人数被拒绝', invalid.status === 400);

  const restored = await jsonRequest('/api/admin/limits', {
    method: 'POST',
    body: JSON.stringify({ maxCallMembers: 6 }),
  }, token);
  check('恢复人数上限', restored.status === 200 && restored.body.maxCallMembers === 6);

  f.close();

  const logs = await jsonRequest('/api/admin/logs?limit=120', {}, token);
  check('日志记录终端注册', (logs.body.logs || []).some((l) => l.message.includes('终端注册')));
  check('日志记录公告推送', (logs.body.logs || []).some((l) => l.message.includes('已推送公告')));
  check('日志记录通话设置', (logs.body.logs || []).some((l) => l.message.includes('更新通话设置')));

  console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
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
