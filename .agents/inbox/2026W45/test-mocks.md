# Mock trong test: thay một bước bằng dữ liệu cố định, có điều kiện

Ghi nhận ngày 2026-11-03. Giai đoạn SDLC: **Design — đã grilling ba lượt, đã viết spec và ticket, chưa có code.** Bản ghi không phải bằng chứng đã triển khai.

## Ý định (theo lời Hong)

Khi đọc [composition-components](composition-components.md): "dường như chúng ta thiếu một simple component: mock. mục đích: mocking data, tiện test?"

Sau ví dụ đầu tiên: "vẫn chưa có conditional what data to response à? nếu fetch(aURL) thì trả khác, fetch(bURL) thì trả khác. các framework như PHPUnit conditional matching này mà?"

## Hiện trạng khi hỏi

Mock dữ liệu đầu vào đã có: input `inject` (chỉ dùng trong test), tham số `input` của `pipeline.test`, `fixtures` theo URL cho `http_fetch`, `llm.mode: "mock"` trả lời theo thứ tự gọi, `clock`, `state` ([agent-surface](../../specs/agent-surface.md#pipeline-tests), `src/harness/pipeline-test.ts`). Hai chỗ thiếu:

- Không mock được một bước ở giữa pipeline. Muốn test phần sau `parse_feed` thì agent phải viết XML feed cho fixture; agent-surface đã ghi đây là rủi ro.
- Mock LLM theo thứ tự gọi sẽ dễ vỡ khi có `switch`, `for_each`, `while`, `workflow` và nhiều `host_llm`.

## Nguồn đã đọc

- Redpanda Connect unit testing: `mocks` thay processor theo label hoặc JSON Pointer bằng processor khác. https://docs.redpanda.com/redpanda-connect/configuration/unit_testing/ , tóm tắt ở [research-benthos](../../research/research-benthos.md) §7 (đọc 2026-11-03).
- PHPUnit: `with()->willReturn()`, `willReturnMap`, `willReturnCallback`. Theo trí nhớ, **not verified**; chỉ dùng làm phép so sánh, không thiết kế dựa trên chi tiết của nó.

## Lượt 1 (2026-11-03)

Hong: "giả sử tôi đồng ý hết", rồi hỏi ví dụ. Cháu coi đây là chấp nhận cả năm đề xuất.

1. **`mocks` ở cấp test, khóa theo step id; không có component `mock` trong pipeline.** Nằm ở `pipeline.test.mocks` và `tests[].mocks`. Pipeline chạy thật không chứa thứ chỉ để test, permission vẫn suy ra từ pipeline thật, test không lệch khỏi thứ sẽ chạy. Giống `mocks` của Redpanda Connect.
2. **Mock một bước bằng `{ "messages": [{ data, meta? }] }`,** phát ra một lần cho mỗi message đi vào, thay cho việc chạy bước đó. Kiểm theo output shape đã khai của bước (`mock_shape_mismatch`). Bước bị mock có `mocked: true` trong `steps[]` của report.
3. **Mock được mọi bước processor,** kể cả bước lồng và bước composition (`try`, `while`, …). Input và output thì không: input đã có `input`, output đã có `results[]`.
4. **Mock LLM theo bước: `{ "<host_llm id>": { "replies": [string] } }`.** Trả theo thứ tự trong bước đó, câu cuối lặp lại. Prompt vẫn vào `llm_requests[]`, vẫn tính vào `llm_calls_per_run`. `llm.responses` dùng chung vẫn giữ.
5. **Chưa có mock lỗi.** **Bị quyết định 9 thay thế.**

## Lượt 2 (2026-11-03)

Viết ví dụ ra thì thấy hai chỗ hở: shape check chặt quá làm mock dài gấp ba, và chưa chọn được câu trả lời theo tham số. Hong: "Yes cả bốn".

6. **Mock chỉ bắt buộc có những field mà các bước sau đọc,** đúng kiểu đã khai. Được bỏ field không ai đọc; không được thêm field lạ (`mock_shape_mismatch`). Nhờ vậy `fetch` bị mock khi `parse` cũng bị mock chỉ cần `{ "data": {} }`. Không cần cú pháp mock theo khoảng (`"fetch..parse"`).
7. **`cases[]`.** Mỗi case có `when` (kiểu `condition` của [composition](../../specs/composition.md#condition)) và đúng một trong `messages`, `replies` (chỉ `host_llm`), `fail`. Case khớp đầu tiên thắng, như `switch`. Case không có `when` là mặc định, phải đứng cuối. `{ "messages": … }` không có `cases` là viết tắt của một case mặc định. Không case nào khớp thì test fail với `mock_unmatched` (như `fixture_missing`), không trả null như stub của PHPUnit, vì null che lỗi.
8. **`when` xét theo đơn vị của quyết định 13 bên composition.** `http_fetch` theo từng URL, thấy `{ "url" }`; mock của nó vẫn gán `meta.source_url` vì đó là danh tính của đơn vị. `host_llm` theo từng message, thấy `{ "prompt", "system" }`, đúng thứ host sẽ nhận. Các bước khác thấy message đi vào (`data`, `meta`).
9. **Có `fail` trong case; thay thế quyết định 5.** Khi `fetch` đã bị mock thì không còn fixture để trả 503, mà "feed c lỗi, a và b vẫn chạy" chính là use case của `try`/`catch`. `code` chỉ là mã mà component thật sinh ra và `try` bắt được: `http_fetch` có `http_status`, `fetch_failed`, `fetch_timeout`, `body_too_large`; `parse_feed` có `feed_invalid`. `host_llm` không có, vì lỗi host không catch được.

**Bỏ có chủ đích:** `willReturnCallback` (chạy code, phạm [ADR 003](../../decisions/003-no-expression-language.md)).

## Lượt 3 (2026-11-03): năm lựa chọn do spec đề xuất

Khi viết [spec test-mocks](../../specs/test-mocks.md), cháu gặp năm chỗ hai lượt trên chưa trả lời. Hong: "Yes cả năm".

10. **Quyết định 6 làm bằng cách thu hẹp shape, không cần chỉ mục "bước nào đọc gì".** Validator đi lại pipeline, lấy output shape của bước bị mock là phần shape mà mọi mock message đều có. Bước sau đọc field mock thiếu thì báo `mock_missing_field` tại mock, nêu field và bước đọc nó. Pointer check của chính bước bị mock thì bỏ qua.
11. **Mock không được đổi việc bước có giữ message id hay không.** Bước giữ id thì mỗi case phát 0 hoặc 1 message, nhiều hơn thì `changes_message_ids`. Không vậy thì một bước bị mock trong `while` phạm quyết định 16 bên composition mà chỉ lộ trong test.
12. **`host_llm` chỉ mock bằng `replies`.** `messages` ở đó sẽ bỏ qua render prompt, `llm_requests[]` và budget, đúng những thứ test một bước gọi model cần kiểm. Hẹp hơn quyết định 7.
13. **Mock một container là thay cả container.** Bước bên trong không chạy; mock một bước nằm trong container đã bị mock thì `mock_unreachable`. Đơn vị của `collect` là cả batch, `when` thấy `{ items, count }`.
14. **`fail` là cuối cùng; `retry` không chạy trên bước bị mock.** Retry vẫn test bằng `fixtures`.

## Ví dụ đã đưa Hong (feed-digest-filter, ba URL trả khác nhau)

```json
"mocks": {
  "fetch": {
    "cases": [
      { "when": { "field": "/url", "equals": "https://news.example.net/atom.xml" },
        "fail": { "code": "http_status", "message": "503" } },
      { "messages": [ { "data": {} } ] }
    ]
  },
  "parse": {
    "cases": [
      { "when": { "field": "meta:source_url", "equals": "https://example.com/feed.xml" },
        "messages": [
          { "data": { "id": "a1", "title": "Alpha a1", "link": "https://example.com/a1" } },
          { "data": { "id": "a2", "title": "Alpha a2", "link": "https://example.com/a2" } }
        ] },
      { "when": { "field": "meta:source_url", "equals": "https://blog.example.org/rss" },
        "messages": [ { "data": { "id": "b1", "title": "Beta b1", "link": "https://blog.example.org/b1" } } ] }
    ]
  },
  "summarize": {
    "cases": [ { "when": { "field": "/prompt", "contains": "Alpha a2" }, "replies": ["The digest."] } ]
  }
}
```

## Liên quan

- Spec: [test-mocks](../../specs/test-mocks.md) (2026-11-03)
- Ticket: [test-mocks-01](../../tickets/test-mocks-01-step-mocks.md), [test-mocks-02](../../tickets/test-mocks-02-cases-fail.md)
- [composition-components](composition-components.md), [agent-surface](../../specs/agent-surface.md#pipeline-tests), [composition](../../specs/composition.md)
