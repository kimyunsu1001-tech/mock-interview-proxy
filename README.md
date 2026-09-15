# 모의면접 AI — 무자본 무료 체험 프록시

방문자가 API 키나 결제수단 없이도 하루 일정 횟수까지 모의면접을 무료로
체험할 수 있게 해주는 Cloudflare Worker입니다. **Cloudflare Workers AI의
무료 일일 할당량(카드 등록 불필요, 매일 00:00 UTC 초기화)**만 사용하므로
소유자도 어떤 API 키나 결제수단을 등록할 필요가 없습니다 — 말 그대로
무자본으로 운영됩니다.

## 왜 무자본인가

- Cloudflare Workers 무료 플랜: 하루 100,000 요청까지 무료, 카드 불필요
- Cloudflare Workers KV 무료 플랜: 하루 100,000 읽기 / 1,000 쓰기까지 무료
- Cloudflare Workers AI 무료 플랜: 하루 10,000 Neurons까지 무료, 카드 불필요
- 이 Worker는 두 겹의 한도(방문자별 하루 메시지 수 + 전체 합산 하루 요청 수)로
  Workers AI 무료 예산을 절대 넘지 않도록 미리 방어합니다. 즉, 원천적으로
  과금될 방법이 없습니다.
- 한도를 넘으면 단순히 "본인 API 키를 입력해 주세요" 안내로 넘어갈 뿐,
  아무 것도 청구되지 않습니다.

## 배포 방법

```bash
cd interview-proxy
npx wrangler login          # Cloudflare 계정 로그인 (브라우저 열림, 무료 가입 가능)
npx wrangler kv namespace create RATE_LIMIT
# 출력된 id 값을 wrangler.toml의 kv_namespaces[0].id 에 붙여넣기

npx wrangler deploy
```

Anthropic API 키를 등록하는 단계가 없습니다 — Workers AI 바인딩만으로
동작합니다. 배포가 끝나면
`https://mock-interview-proxy.<계정>.workers.dev` 형태의 URL이 출력됩니다.
이 URL을 프론트엔드(`app.js`)의 `PROXY_URL` 값으로 설정하면 무료 체험
모드가 활성화됩니다.

## 사용량 제한

- 방문자(IP)당 하루 14메시지 (`DAILY_FREE_LIMIT`)
- 전체 방문자 합산 하루 400요청 (`GLOBAL_DAILY_CAP`) — Workers AI 무료
  일일 예산(뉴런 10,000개) 안에 안전하게 들어오도록 여유 있게 설정
- 두 한도 중 하나라도 초과하면 429를 반환하고, 프론트엔드는 자동으로
  "본인 API 키 입력" 화면으로 전환됩니다.
- 사용된 모델: `@cf/meta/llama-3.1-8b-instruct` (경량 모델이라 하루 무료
  예산 안에서 더 많은 응답을 처리할 수 있습니다)

## 품질 차이

무료 체험은 오픈소스 소형 모델(Llama 3.1 8B)을 사용하므로, 방문자가 직접
Anthropic API 키를 입력해 Claude를 사용하는 모드보다 답변 품질이 다소
낮을 수 있습니다. 이는 의도된 트레이드오프입니다 — 무료 체험은 "가볍게
먼저 써보기" 용도이고, 진지하게 준비할 때는 본인 키로 전환하도록
안내합니다.
