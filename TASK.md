# rosud-call v2 개발 태스크

## 노션 설계 문서
https://www.notion.so/rosud-call-v2-npm-SDK-3256591febba81ccb11ae6443dbf28fd

## 목표
npm install rosud-call 한 줄로 설치, 즉시 사용 가능한 봇 메시징 SDK

## 현재 상태
- src/index.js: 335줄, 단일 파일 (모든 로직 혼재)
- 모듈 분리 안 됨
- router.js 없음
- startPolling() 없음

## 해야 할 일

### 1. 모듈 분리 (src/)
기존 index.js를 모듈별로 분리:

#### src/sanitizer.js
- LLM 헤더 제거 로직
- 정규식 기반: "Human:", "Assistant:", "System:", "---\n초안", "---\n draft" 등
- exports: sanitize(content) → string

#### src/lock.js  
- 파일 기반 lock (flock 방식)
- stale lock 자동 해제 (600초 초과)
- exports: acquireLock(lockFile), releaseLock(lockFd)

#### src/dedup.js
- 60초 TTL 캐시 (파일 기반)
- exports: isDuplicate(content, ttlMs, cacheFile), markSent(content, ttlMs, cacheFile)

#### src/poller.js
- REST 폴링 로직
- limit=200, UUID last_id 커서
- after 파라미터 절대 사용 금지
- exports: Poller class

#### src/ws-client.js
- WebSocket 연결 + 지수 백오프 재연결
- ping/pong 헬스체크 (30초)
- subscribe ACK 확인
- exports: WsClient class

#### src/client.js
- REST API 클라이언트
- exports: ApiClient class

#### src/router.js
- 메신저 라우팅 규칙 엔진
- 4가지 context: 'dm', 'group', 'autonomous', 'cross-platform'
- exports: MessageRouter class
```js
// 사용 예:
const router = new MessageRouter({
  context: 'group',
  messengerChatId: '-5208187269',
  humanId: '8171314672',
  messengerFn: async (chatId, text) => { /* TG 발신 */ },
  keywords: ['완료', '에러', 'done', 'error', 'failed'],
})
// rc.on('message', (msg) => router.route(msg))
```

#### src/index.js (리팩토링)
- 위 모듈들 import해서 RosudCall 클래스 조립
- 기존 API 완전 호환 유지:
  - new RosudCall({ apiKey, botId, serverUrl, wsUrl, dedupTtlMs, sanitize, skipSenders })
  - rc.connect(roomId)
  - rc.disconnect()
  - rc.poll(roomId, { stateFile, limit })
  - rc.startPolling(roomId, { intervalMs, stateFile })
  - rc.stopPolling()
  - rc.send(roomId, content)
  - rc.createRoom({ name, roomType, maxTurns, memberIds })
  - rc.getRooms()
  - rc.on('message', handler)
  - rc.on('connected', handler)
  - rc.on('disconnected', handler)
  - rc.on('reconnecting', handler)
  - rc.on('error', handler)

### 2. package.json 업데이트
```json
{
  "name": "rosud-call",
  "version": "2.0.0",
  "description": "Bot messaging SDK — npm install rosud-call",
  "main": "src/index.js",
  "type": "commonjs",
  "engines": { "node": ">=18" },
  "scripts": {
    "test": "node test/run-tests.js",
    "test:bot-a": "node test/bot-a.js",
    "test:bot-b": "node test/bot-b.js"
  },
  "keywords": ["rosud", "bot", "messaging", "websocket", "ai-agent"],
  "license": "MIT",
  "dependencies": {
    "ws": "^8.0.0"
  }
}
```

### 3. test/ 업데이트

#### test/bot-a.js (발신 봇)
- rosud-call SDK 로드
- .secrets 파일에서 인증정보 로드
- BOT_MESSAGING_ROOM_BRIDGE 방에 10개 메시지 발신 (1초 간격)
- 자기 에코가 수신되지 않는지 검증
- 완료 후 결과 출력

#### test/bot-b.js (수신+에코 봇)
- rosud-call SDK 로드
- .secrets 파일에서 인증정보 로드 (bot_id: "kavin-desktop-general-work")
- BOT_MESSAGING_ROOM_BRIDGE 방 구독
- 수신 메시지 에코 응답
- 60초 후 자동 종료

#### test/run-tests.js
- unit test: sanitizer, dedup, lock 모듈 테스트
- 의존성 없이 순수 JS 테스트

### 4. README.md 업데이트
Quick Start 포함, 3가지 모드 예제, 환경변수 설명

## 중요 규칙
- .secrets 파일 경로: /home/kasm-user/.openclaw/workspace/.secrets
- API 서버: https://api.rosud.com/bot-api
- WS 서버: wss://api.rosud.com/bot-ws
- WS 인증: Authorization: Bearer {api_key}
- REST 인증: X-API-Key: {api_key}
- after 파라미터 절대 사용 금지 (버그)
- limit=200 고정
- sender_id === botId 자동 필터

## 완료 시
openclaw system event --text "rosud-call v2 Phase1 개발 완료: src 모듈 분리, router.js, startPolling(), README 업데이트 완료" --mode now
