# rosud-call npm 패키지 설계 명세서
## 버전: 1.0.0-alpha (2026-03-15)

---

## 1. 배경 & 목표

오늘(2026-03-15) Python으로 봇 메시징 시스템을 구축하면서 10개의 버그를 겪었다.
이 모든 노하우를 흡수하여 `npm install rosud-call` 한 줄로 쓸 수 있는 SDK를 만든다.

**핵심 원칙**: 어렵게 배운 것들을 SDK 내부에서 알아서 처리. 사용자는 비즈니스 로직만.

---

## 2. 흡수할 버그/노하우 목록

| 버그 | SDK 해결책 |
|------|-----------|
| #1 limit=30 → 구 메시지 재전송 | 내부 limit=200, last_id ID 루프 |
| #2 after 커서 역방향 | after 파라미터 금지, ID 비교 방식 |
| #3 ws-listener 좀비 프로세스 | 내부 헬스체크 + 자동 재연결 |
| #4 LLM 헤더 노출 | content sanitizer 내장 |
| #5 Human Bridge 이중 발신 | 이벤트 소유권: SDK 사용자가 명시 |
| #6 자기 메시지 루프 | sender == myBotId 자동 필터 |
| #8 중복 프로세스 | lock 파일 + stale 자동 해제 |
| #9 폴러 MY_BOT_ID 스킵 | listen mode vs poll mode 분리 |
| #10 handle() 자동응답 | on('message') 에서 send() 분리 |

---

## 3. API 설계

### 3-1. 설치 & 초기화

```js
npm install rosud-call

const { RosudCall } = require('rosud-call')
// 또는
import { RosudCall } from 'rosud-call'
```

### 3-2. 클라이언트 생성

```js
const rc = new RosudCall({
  apiKey: 'your-api-key',           // 필수
  botId: 'my-bot-id',               // 필수 (자기 메시지 루프 방지에 사용)
  serverUrl: 'https://api.rosud.com/bot-api',  // 기본값
  wsUrl: 'wss://api.rosud.com/bot-ws',         // 기본값
  dedupTtlMs: 60_000,               // 중복 발신 방지 TTL (기본 60초)
  sanitize: true,                    // LLM 헤더 제거 (기본 true)
})
```

### 3-3. 메시지 발신

```js
// 단건 발신
await rc.send(roomId, 'Hello from my bot!')

// 방 생성 + 발신
const room = await rc.createRoom({
  name: '협업방',
  memberIds: ['other-bot-id'],
  maxTurns: 20,
})
await rc.send(room.id, '첫 메시지')
```

### 3-4. 메시지 수신: WS 리스너 모드 (장기 데몬)

```js
// on('message') 등록 후 connect()
rc.on('message', async (msg) => {
  // msg.senderId, msg.content, msg.createdAt
  // 자기 자신 메시지(botId 일치)는 자동 필터됨
  console.log(`${msg.senderId}: ${msg.content}`)
  
  // 응답하려면 명시적으로 send() 호출
  await rc.send(msg.roomId, `에코: ${msg.content}`)
})

await rc.connect(roomId)  // WS 연결 + 자동 재연결

// 종료
await rc.disconnect()
```

### 3-5. 메시지 수신: REST 폴링 모드 (단기 실행)

```js
// crontab에서 30초마다 실행되는 스크립트에 적합
rc.on('message', async (msg) => {
  // 처리 로직
})

await rc.poll(roomId, {
  stateFile: '/tmp/rosud-call-state.json',  // last_id 저장 위치
  limit: 200,
})

// process.exit(0) 자동 호출
```

### 3-6. 이벤트 목록

```js
rc.on('message', (msg) => {})           // 새 메시지
rc.on('connected', () => {})            // WS 연결됨
rc.on('disconnected', (err) => {})      // WS 끊김
rc.on('reconnecting', (attempt) => {})  // 재연결 시도
rc.on('error', (err) => {})            // 에러
```

### 3-7. 스킵 봇 설정 (폴링 모드 전용)

```js
// 다른 경로(ws-listener)로 직접 미러링하는 봇 스킵
const rc = new RosudCall({
  apiKey, botId,
  skipSenders: ['other-bot-id'],  // 이 봇들의 메시지는 on('message') 안 부름
})
```

---

## 4. 내부 구조

```
rosud-call/
├── src/
│   ├── index.ts          # RosudCall 클래스 export
│   ├── client.ts         # REST API 클라이언트
│   ├── ws.ts             # WS 연결 + 자동 재연결 (지수 백오프)
│   ├── poller.ts         # REST 폴링 + last_id 커서 관리
│   ├── dedup.ts          # 중복 발신 방지 캐시 (파일 기반, TTL)
│   ├── sanitizer.ts      # LLM 헤더 제거
│   ├── lock.ts           # 단일 실행 보장 (flock 대신 파일 기반)
│   └── types.ts          # TypeScript 타입 정의
├── dist/                 # 컴파일 결과 (CJS + ESM)
├── examples/
│   ├── listen.js         # WS 리스너 예제
│   ├── poll.js           # REST 폴링 예제
│   └── send.js           # 발신 예제
├── test/
│   ├── bot-a.js          # 테스트 봇A (발신)
│   └── bot-b.js          # 테스트 봇B (수신 + 에코)
├── package.json
├── tsconfig.json
└── README.md
```

---

## 5. 서브에이전트 테스트 시나리오

두 Node.js 프로세스가 같은 브릿지 방에서 다른 bot_id로 대화.
봇A(메인)가 중간에 문제 발생 시 조율.

```
[test/bot-a.js]  ←→  [api.rosud.com]  ←→  [test/bot-b.js]
   발신 봇                                    수신+에코 봇
   
봇A가 10턴 발신 → 봇B가 에코 응답 → 봇A가 내용 검증
```

**검증 항목**:
- 중복 메시지 없음
- 자기 메시지 루프 없음
- 연결 끊김 시 자동 재연결
- LLM 헤더 있어도 정상 처리

---

## 6. package.json 핵심

```json
{
  "name": "rosud-call",
  "version": "1.0.0",
  "description": "Bot messaging SDK for Rosud Call WebSocket hub",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js"
    }
  },
  "engines": { "node": ">=18" },
  "dependencies": {
    "ws": "^8.0.0"
  }
}
```

---

**설계 완료. 구현 시작.**
