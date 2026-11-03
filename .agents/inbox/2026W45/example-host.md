# Example host: một host mẫu chạy được, nằm trong repo

Ghi nhận ngày 2026-11-03. Giai đoạn SDLC: **Code đã viết trước khi grilling; đã grilling một lượt, đã viết spec và ticket.** Bản ghi không phải bằng chứng đã đạt yêu cầu.

**Sai quy trình.** Cháu viết `examples/host/` và commit `5f70022` vào `main` khi chưa có file này, chưa grilling, chưa spec. Hong: "chưa, chưa inbox, grill, spec, … đã làm rồi à?", rồi "không cần gỡ; giờ đưa vào inbox". Code giữ nguyên; lượt grilling dưới đây xét lại những lựa chọn cháu đã chốt ngầm trong code. Quyết định nào khác với code thì code đổi theo, qua ticket.

## Ý định (theo lời Hong)

"tôi muốn có một thí dụ cụ thể ở bên trong code base: example host integration."

## Quyết định có trước grilling (2026-11-03, qua hộp chọn)

1. **Phạm vi: host + agent tool loop.** Host chạy được: spawn engine, initialize, gọi Claude thật cho `host.llm`, idempotency, typed errors, đếm budget, thẻ duyệt trong terminal, lưu run report; thêm tool loop để người gõ yêu cầu bằng lời và model gọi các tool `workflow_*`.
2. **Vị trí: `main`, `examples/host/`.** Bổ trợ cho [host-integration](../../../docs/host-integration.md).

## Hiện trạng khi hỏi

Đã có trong commit `5f70022`:

- `rpc.ts` (spawn, đọc dòng trên luồng riêng, JSON-RPC), `provider.ts` (Claude qua SDK, map lỗi sang typed error, provider giả theo kịch bản), `host.ts` (handshake, `host.llm`, `host.result`, thẻ duyệt, report), `agent.ts` (tool loop), `main.ts` (CLI `run` và `chat`), `pipelines/hello.json`, 8 test, README.
- Đã chạy 2026-11-03 trên macOS 27.0.1, Bun 1.4.3: 8 test của example và `run --offline`, với binary engine thật và Seatbelt bật. Suite engine 497/497.
- **Chưa từng gọi provider thật** (máy không có key). `chat` mới chạy qua model giả trong test.

## Nguồn đã đọc

- Bảng giá Claude: Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50 mỗi triệu token input/output với prompt đến 100 000 token ($0.50 / $2.50 trên mức đó). https://platform.claude.com/docs/en/about-claude/pricing (đọc 2026-11-03). Khớp bảng trong `provider.ts`, trừ bậc giá Haiku trên 100 000 token mà code chưa tính.
- `@anthropic-ai/sdk` 1.4.0: license Apache-2.0; phụ thuộc kèm theo `@babel/runtime`, `@stablelib/base64`, `json-schema-to-ts`, `standardwebhooks`, `ts-algebra` (MIT), `@opentelemetry/api` (Apache-2.0), `fast-sha256` (Unlicense). Đọc từ `node_modules/*/package.json` 2026-11-03.
- Hành vi SDK khi không có credential: ném `Error` thường "Could not resolve authentication method…", không có class riêng (chạy thử 2026-11-03).
- `stream.get` của engine trả `pending: { pipeline, permissions, permissions_hash, rendered }`, không có `diff` (`src/engine/engine.ts`, đọc 2026-11-03).

## Lượt 1 (2026-11-03)

Hong: "grilling 1: đồng ý hết". Cả tám đề xuất dưới đây là quyết định. Cùng lúc, Hong cho viết lại lịch sử để bỏ một nhắc tới việc nội bộ khỏi message của commit example host trên `main` (commit mới `be50038`, chưa push).

3. **Package riêng, và `bun test` ở gốc chỉ quét `tests/`.** `examples/host/` có `package.json` và lockfile riêng nên dependency của nó không vào binary engine; `bunfig.toml` (`[test] root = "tests"`) giữ suite engine như cũ; `bun run test:example` chạy test của example. Đề xuất: giữ.
4. **SDK chính thức thay vì `fetch` thẳng.** SDK cho class lỗi có kiểu và type cho tool loop; đổi lại 8 package, hai cái Apache-2.0. Apache-2.0 là license permissive, dùng được trong repo MIT, chỉ cần giữ NOTICE nếu phân phối lại; ở đây không phân phối. Đề xuất: giữ SDK, ghi lý do và danh sách license vào spec của example (quy tắc AGENTS: dependency mới cần một dòng trong spec).
5. **Model mặc định.** Opus 5.5 cho cả `host.llm` (effort `low`) và chat (effort `high`), bật `fallbacks: "default"` (request bị bộ lọc an toàn từ chối được chạy lại trên model khác); `--model` để đổi. Đề xuất: giữ. Phương án khác: Haiku 5.5 cho `host.llm`, rẻ hơn 40 lần.
6. **Không retry ở provider (`maxRetries: 0`).** Lỗi đi thẳng vào report thành typed error, cùng tinh thần "no retry by default" của engine. Đề xuất: giữ.
7. **Báo chi phí.** Khai `llm_reports_cost: true` và tính `cost_usd` từ bảng giá trong code; model không có trong bảng thì không báo. Bảng đã khớp trang giá (xem Nguồn). Đề xuất: giữ, ghi nguồn và ngày đọc vào code, thêm bậc giá Haiku trên 100 000 token.
8. **`stream.get` không trả `diff` cho update đang chờ duyệt.** Host mẫu đang tự tính diff từ hai bộ câu. [host-integration](../../../docs/host-integration.md) nói `pending` có để thẻ hiện lại sau khi host khởi động lại, mà thẻ của update cần diff. Đề xuất: sửa engine cho `pending` có `diff` (đổi spec host-protocol, một ticket), rồi host mẫu dùng nó.
9. **Chạy thật một lần với provider.** Một lần `run pipelines/hello.json` và một lượt `chat`, ghi ngày, model, số token vào README. Đề xuất: làm khi Hong đặt key; tốn vài cent.
10. **Spec và ticket cho phần đã có.** Đề xuất: viết spec ngắn `.agents/specs/example-host.md` từ quyết định 1–9; code hiện có được nhận sau khi Hong đọc; ticket chỉ cho phần chênh lệch (8, 7, 9 và câu nào Hong trả lời khác đề xuất).
