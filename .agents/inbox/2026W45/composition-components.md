# Component composition: port gì từ Redpanda Connect

Ghi nhận ngày 2026-11-03. Giai đoạn SDLC: **Plan — đã grilling, chưa viết spec, chưa có ticket, chưa có code.** Bản ghi không phải bằng chứng đã triển khai. Phạm vi v0 ([quyết định 4 của grilling đầu](wriven-workflow.md#quyết-định-sau-grilling-2026-11-03)) không đổi; đây là danh sách cho sau v0.

## Ý định (theo lời Hong)

"nghiên cứu redpanda connect >> những components nào đáng để port nhất (không xét đến độ khó, chỉ xét đến độ hữu dụng, generic for most of cases: parallel, switch, ...)"

Sau khi cháu đưa bảng xếp hạng, Hong đưa danh sách của mình: `try`, `sleep`, `retry`, `log`, `jq`, `for_each`, `mapping`, `metrics`, `while`, `workflow`. Rồi: "cái nào phạm thì bỏ qua; còn `catch` processor?"

## Nguồn đã đọc

Tất cả đọc ngày 2026-11-03.

- Catalog processor: https://docs.redpanda.com/redpanda-connect/components/processors/about/ và https://warpstreamlabs.github.io/bento/docs/components/processors/about
- Trang chi tiết: `switch`, `parallel`, `while`, `cached`, `group_by_value`, `text_chunker`, `try_catch` dưới https://docs.redpanda.com/redpanda-connect/components/processors/
- Output `broker`, `switch`, `fallback`, `retry` và mô hình lỗi `try`/`catch`: [research-benthos.md](../../research/research-benthos.md) §1, §2, §8, §9

Nhận xét chính khi đọc: phần "generic" của Redpanda phần lớn nằm trong Bloblang, không nằm trong component. `switch.check`, `while.check`, `cached.key`, `group_by_value.value`, `branch.request_map`, lọc bằng `root = deleted()` đều là biểu thức. Port component mà không có Bloblang thì mỗi chỗ đó phải thành một trường khai báo có schema.

## Quyết định (2026-11-03)

1. **Bỏ `jq` và `mapping`.** Cả hai là ngôn ngữ biểu thức, phạm [ADR 003](../../decisions/003-no-expression-language.md) và quyết định 14 bên sidecar của wriven-desktop ("không có component chạy mã nội tuyến"). Ghi lại để lần sau khỏi tính lại: `jq` qua được phần lớn tiêu chí mở lại ADR 003, vì nó thuần, không IO, nên permission vẫn suy ra từ component. Cái giá thật là validation không còn total (shape đầu ra của biểu thức không suy được) và thêm một dependency vào binary; còn tiêu chí "một tác vụ cụ thể component không diễn đạt được" thì chưa có bằng chứng. Nếu có ngày mở lại thì chọn `jq`, không bao giờ `mapping` (phải viết lại cả Bloblang, tên dính trademark).
2. **Bỏ `metrics`.** Redpanda cần metrics vì là server chạy lâu cho Prometheus scrape. Engine này là process con chạy theo lần; run report đã có `steps[].in/out/dropped/duration_ms` và từng request LLM (`src/report.ts`).
3. **`catch` không đứng riêng; gộp vào `try`, theo hình dạng `try_catch` của Redpanda (4.98.0, beta).** `catch` đứng riêng cần cờ lỗi đi theo message (flag-and-continue), mô hình spec đã loại ([pipeline-format](../../specs/pipeline-format.md), quyết định 5). `try` là một nhóm bước có `steps` và `catch`:
   - Message lỗi ở một bước trong `steps` thì bỏ các bước còn lại của nhóm cho message đó, rồi chạy `catch` trên nó.
   - **Chỗ để lỗi:** ba key metadata cố định `meta:error_step`, `meta:error_code`, `meta:error_message`, vì `meta` là `string → string`. Không có trường kiểu `error_metadata`.
   - **Bắt được gì:** chỉ các lỗi processor mà `on_error: skip` vốn bỏ qua được. Lỗi typed từ host ở `host_llm`, vượt limits, timeout, cancel vẫn dừng run. Không thì `catch` thành cửa sau lách "no retry, no fallback by default".
   - `catch: []` nghĩa là skip (như `on_error: skip` ở cấp nhóm). Không có `catch` thì `try` fail run.
   - Lỗi xảy ra trong `catch` theo luật thường, không bị nuốt.
   - **Permission:** code render thành câu, ví dụ "If fetching or parsing a feed fails, writes a note about the failure instead." Permission của component trong `catch` cộng vào tập chung.
   - Giá trị: hôm nay `on_error: skip` bỏ feed lỗi trong im lặng; có `catch` thì digest ghi được "feed X hôm nay không đọc được". Đúng tinh thần "hide the mechanism, never the consequences".
4. **`for_each` gộp với `parallel` thành một component có `cap`;** `cap: 1` là `for_each`. Hiện `host_llm` và `http_fetch` chạy tuần tự từng message. Mọi lời gọi LLM trong đó vẫn tính vào `llm_calls_per_run`.
5. **`while` lấy, `max_loops` bắt buộc** (Redpanda mặc định `0` = vô hạn). Use case: hỏi lại model cho đến khi output khớp schema, phân trang. `check` cần một điều kiện khai báo; xem điểm mở 1.
6. **`workflow` lấy.** DAG các nhánh; vì tham chiếu là JSON Pointer nên suy luận phụ thuộc được chính xác từ cặp đọc/ghi, không phải "best attempt" như Redpanda. Nó bao luôn `branch`.
7. **`sleep` lấy.** Validator kiểm tra tổng `sleep` có thể xảy ra nhỏ hơn `run_timeout`.
8. **`log` lấy, nghĩa là ghi một dòng vào run report.** Engine không có logger chung; agent cần nó để debug pipeline.
9. **`retry` lấy dạng wrapper,** với hai ràng buộc: bọc `host_llm` thì mỗi lần thử lại tính vào `llm_calls_per_run`, và có câu permission riêng ("Retries … up to N times."). Quan hệ với trường `retry` sẵn có trên `http_fetch`, `host_result`: xem điểm mở 3. **Bị quyết định 12 thay thế.**

Danh sách sau lượt 1: `try` (gồm `catch`), `retry`, `for_each` (có `cap`), `while`, `workflow`, `sleep`, `log`.

## Điểm mở của lượt 1

Ba điểm dưới đây đã được trả lời ở lượt 2; giữ nguyên văn để biết đã hỏi gì.

1. **Kiểu `condition` khai báo dùng chung**, ví dụ `{ "pointer": "/title", "contains": "Rust" }` với `equals`, `in`, `contains`, `exists`, `gt`/`lt`; regex tạm để ngoài (ReDoS, khó render thành câu). `while` cần nó ngay; `filter`, `switch` và `cached.skip_on` sau này dùng chung. Cháu đề xuất làm nó trước mọi component trong danh sách.
2. **`switch`, `filter`, `split` không có trong danh sách của Hong.** Bảng xếp hạng đầu của cháu đặt chúng ở tier 1 (`filter` là thao tác phổ biến nhất, `split` là nghịch đảo của `collect`). Khi đã bỏ `jq` thì không component nào khác làm thay được. Cần Hong xác nhận bỏ có chủ đích hay thêm vào.
3. **`retry` wrapper hay trường `retry` theo component**, chọn một, không giữ cả hai.

## Lượt 2 (2026-11-03)

Hong trả lời: "end users là agent, cho nên thiết kế thuận tiện cho agent là được" và "retry per component có vẻ hợp lý hơn."

Cháu hiểu câu thứ nhất là trả lời cho điểm mở 1 và 2: người viết pipeline là agent, nên chọn hình dạng và bộ component mà agent dùng thuận nhất. Người dùng vẫn đọc câu permission lúc duyệt, nên mọi thứ vẫn phải render được thành câu tiếng Anh; phần đó không đổi.

10. **Có kiểu `condition` khai báo dùng chung, làm trước mọi component composition.** Hình dạng cụ thể chốt ở spec. Hướng thiết kế theo "thuận cho agent":
    - Một điều kiện lá là `{ "pointer": <JSON Pointer hoặc meta:key>, <toán tử>: <giá trị> }`. Toán tử: `equals`, `in`, `contains` (chuỗi con hoặc phần tử mảng), `starts_with`, `exists`, `gt`/`gte`/`lt`/`lte`, và `newer_than: "24h"` (so với giờ chạy, dùng đồng hồ giả trong test được). `contains` và `starts_with` có `case: "insensitive"`.
    - Gộp bằng `all`, `any`, `not`, có giới hạn độ sâu. Đây là cây boolean, không tính toán, nên không phạm ADR 003.
    - Validation kiểm kiểu theo shape đã khai báo (`gt` trên trường chuỗi → `shape_mismatch`).
    - Regex vẫn để ngoài. Lý do là an toàn chứ không phải tiện: RegExp của JS là backtracking (ReDoS), muốn chạy tuyến tính thì phải kéo thêm dependency.
    - Pointer không tồn tại thì điều kiện là false (không phải lỗi); `exists` dùng khi agent cần phân biệt. Điểm này spec xác nhận lại.
11. **Thêm `filter`, `switch`, `split`.** Khi đã bỏ `jq`, không có chúng thì agent phải chắp vá vòng vo (lọc từ khóa, định tuyến theo loại, tách mảng do model trả về). `filter` và `switch` dùng kiểu `condition` của quyết định 10; `split` là nghịch đảo của `collect`.
12. **Retry là trường theo từng component, không có wrapper `retry`.** Thay thế quyết định 9. Giữ hình dạng đang có trên `http_fetch` và `host_result` (`{ "max_attempts", "backoff" }`, không có thì không retry) và mở rộng sang component mới khi cần. `host_llm` vẫn không có `retry`; lỗi typed từ host vẫn dừng run.

**Danh sách sau lượt 2:** `condition` (kiểu dùng chung, không phải component), `filter`, `switch`, `split`, `try` (gồm `catch`), `for_each` (có `cap`), `while`, `workflow`, `sleep`, `log`.

## Những gì cháu xếp hạng mà danh sách trên chưa có

Để tham khảo khi mở lại. Tier 2: `group_by_value` (key là pointer), `json_schema` (chặn output model sai cấu trúc), `cached` (có state, cần câu "Keeps: …"), `text_chunker`, và các thứ Bloblang đang che: `sort_by`, `take`, `set`/`copy`/`delete` theo pointer. Tier 3: output `broker` (`fan_out`), output `switch`, `fallback` (chỉ có nghĩa khi có hơn một output), `rate_limit`. Không port: `command`, `subprocess` (cấm), `javascript`, `wasm`, `awk`, `jmespath`, `bloblang` (ADR 003), connector theo giao thức, `crash`, `benchmark`, `sync_response`.

## Liên quan

- Spec: [composition](../../specs/composition.md) (2026-11-03)
- [Grilling đầu](wriven-workflow.md), [pipeline-format](../../specs/pipeline-format.md), [ADR 003](../../decisions/003-no-expression-language.md), [research-benthos](../../research/research-benthos.md), [câu hỏi mở](../../open-questions.md)
