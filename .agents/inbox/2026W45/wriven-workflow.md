# wriven-workflow: stream processor cho agent, phục vụ Wriven trước

Ghi nhận ngày 2026-11-03 từ brief của Hong. Giai đoạn SDLC: **Plan → Design — đã grilling cùng ngày, đã viết spec, chưa có code, chưa tạo repo GitHub.** Bản ghi không phải bằng chứng đã triển khai.

Tài liệu này là nơi duy nhất trong repo viết tiếng Việt ([quyết định 2](#quyết-định-sau-grilling-2026-11-03)). Phần còn lại của repo viết tiếng Anh.

## Ý định (theo brief của Hong)

Một stream processor kiểu Benthos (nay là Redpanda Connect; fork MIT là Bento), viết bằng TypeScript, theo tinh thần pi coding agent: lõi nhỏ, phần còn lại là extension. Không dùng chữ "Benthos" trong tên package hay tên lệnh.

**Định vị: công cụ cho agent, người dùng không cần biết nó tồn tại.** Người dùng nói ý định ("Every weekday at 8:00, summarize new posts from these 3 feeds"); agent trong Wriven biến ý định thành pipeline, kiểm thử rồi bật. Người dùng không bao giờ thấy YAML.

**Lý do tồn tại:** nếu không có nó, agent muốn tự động hóa phải viết script rồi chạy shell. Pipeline dạng dữ liệu thì validate được bằng schema, kiểm thử được với input giả, quyền khai báo sẵn, sửa thì có diff và rollback được. **Một ngôn ngữ hẹp an toàn hơn code tự do.** Mọi lựa chọn thiết kế phải phục vụ luận điểm này.

Dự án độc lập, giấy phép MIT, nhưng trước mắt chỉ phục vụ nội bộ cho wriven-desktop. Người quyết định là Hong.

### Tám nguyên tắc Hong đề xuất (đầu vào, không phải quyết định)

1. Ẩn cơ chế, không ẩn hệ quả; phần quyền dịch máy móc được ra câu tiếng Anh.
2. Host luôn là tiến trình cha; app đóng thì `launchd` chạy binary Wriven với cờ `--run-scheduled`.
3. Không bao giờ giữ key provider; bước cần LLM gọi ngược về host (`host_llm`).
4. Agent chỉ viết config, không viết extension; chế độ agent tắt nạp module lạ.
5. Mặc định không retry, không fallback.
6. Không có tiến trình con ở chế độ agent.
7. Có version cho giao thức RPC, định dạng pipeline và định dạng kết quả.
8. Kiểm thử được mà không cần dịch vụ thật.

### Ngoài phạm vi v0 (theo brief)

Hàng trăm connector; agent tự viết extension; giao diện người dùng riêng; chạy phân tán; kênh điều khiển ngoài stdio; thay `AgentProvider` của Wriven; nhúng runtime JS vào app Wriven.

## Những gì phía wriven-desktop đã chốt trước, và thắng brief này

Đọc repo `wriven-desktop` ngày 2026-11-03, commit `a72bbe8` (08:52). Hai phiên grilling cùng ngày ở đó có quyết định mới hơn brief; theo luật của brief, file đó thắng.

- [`scheduled-actions.md`](https://github.com/and1truong/wriven-desktop/blob/main/.agents/inbox/2026W44/scheduled-actions.md): **không chạy khi app đóng**; bản đầu chỉ Codex, dùng form, timer trong app, lịch hằng ngày/hằng tuần, lỡ lịch chạy bù đúng một lần; trần 5 tác vụ, chạy lần lượt, mỗi lần tối đa 10 phút.
- [`benthos-ts-sidecar.md`](https://github.com/and1truong/wriven-desktop/blob/main/.agents/inbox/2026W45/benthos-ts-sidecar.md), lượt 2 (quyết định 8–15): **ghi lại, chưa làm**; mở lại khi đặt lịch bằng lời đã chạy thật và có một tác vụ mà schema hẹp (lịch, nguồn, prompt, đích) không diễn đạt được. **Wriven gánh khóa, provider, SQLite, lịch, duyệt và usage**; sidecar chỉ đọc feed, lọc bài mới, nối các bước. Lời duyệt do code sinh từ config, model không viết. "about 2 requests per run" phải là **trần Wriven chặn**, không phải ước lượng. Agent chỉ viết config, không có component chạy mã nội tuyến, Wriven chịu trách nhiệm chuỗi cung ứng của bộ package. Wriven luôn là cha, sidecar không giữ key, tự thoát khi stdin đóng, `test` giả lập được lời gọi LLM. `--run-scheduled` chỉ là ứng viên.
- [`client-side-tool-loop.md`](https://github.com/and1truong/wriven-desktop/blob/main/.agents/inbox/2026W45/client-side-tool-loop.md): vòng lặp tool phía client là ý định riêng, điều kiện tiên quyết của đặt lịch bằng lời; chưa chọn thiết kế.
- Dữ kiện đã thử trên máy (ghi trong file sidecar): Keychain giữ được quyền khi chạy headless nếu chữ ký ổn định; `codex` không chạy được dưới `launchd` vì `PATH`; `SMAppService` cần `.app`; không có chốt một instance.

Hệ quả trực tiếp cho dự án này: nguyên tắc 2 (launchd) không còn là thiết kế v0; "ai giữ lịch" trả lời là Wriven giữ, engine giữ đồng hồ chỉ khi host không giữ; số lời gọi LLM là trần bắt buộc trong pipeline, không phải ước lượng.

## Quyết định sau grilling (2026-11-03)

Vòng 1 gồm 14 câu. Hong trả lời yes cho 12 câu; Q3 (runtime) và Q11 (cô lập) được hỏi lại ở vòng 2 sau khi Hong nêu ba điểm: Deno đã về Cloudflare; Bun dùng engine của WebKit; macOS có sandbox và Anthropic có `sandbox-runtime`. Hong yes cả hai câu hỏi lại.

1. **Vị trí so với wriven-desktop.** Chế độ chính là host-attached: host là cha, nói JSON-RPC qua stdio, host khai báo ở handshake ai giữ đồng hồ (`clock: host | engine`); Wriven dùng `host`. `--run-scheduled`/`launchd` chỉ ghi vào open-questions là điều kiện chưa đạt, không thiết kế. Nguyên tắc 2 hạ xuống "đường tương lai".
2. **Ngôn ngữ tài liệu: tiếng Anh**, trừ `.agents/inbox/` giữ tiếng Việt. Lý do: repo MIT công khai, hợp đồng tích hợp dày định danh kỹ thuật, câu quyền và lỗi vốn tiếng Anh.
3. **Runtime: Bun, đóng gói bằng `bun build --compile`.** Vòng 1 cháu đề xuất Deno vì có quyền theo worker và cưỡng chế heap; Hong chỉ ra Cloudflare đã mua Deno. Kiểm lại: [bài chính thức ngày 2026-10-09](https://deno.com/blog/cloudflare) nói runtime được bảo trì thêm một năm rồi "put our future development work into this shared platform rather than continuing to develop a separate runtime". Bun được Anthropic mua ngày 2025-12-02 với cam kết giữ MIT và cùng đội phát triển ([nguồn](https://bun.com/blog/bun-joins-anthropic)). Số đo trên máy Hong (2026-11-03): Bun 59,5 MB, khởi động 7 ms; Deno 64,5 MB, 14 ms; Node SEA 115–139 MB, 33 ms, còn experimental ở Node 26 LTS. Bun không có mô hình quyền và bỏ qua `resourceLimits` của worker; hai điểm yếu này chuyển sang quyết định 11. Bun dùng JavaScriptCore từ fork WebKit riêng, không phải `JavaScriptCore.framework` của macOS; đường "dùng JavaScriptCore hệ thống qua Swift" bị loại vì phải tự viết cả runtime và vi phạm "không nhúng runtime JS vào app". Chi tiết ở [ADR 001](../../decisions/001-runtime-bun.md).
4. **Phạm vi v0: đúng bộ component đủ cho ví dụ feed.** Input `host_trigger`, `schedule`, `inject`; processor `http_fetch`, `parse_feed`, `dedupe`, `template`, `host_llm`; output `host_result`, `drop`. Khi viết spec phát hiện ví dụ cần gom nhiều bài thành một lời gọi LLM, nên thêm processor `collect` (gom batch thành một message); tổng 11 component. Không `file`, không `http_server`, không stdin/stdout connector, không webhook ra ngoài.
5. **Không có ngôn ngữ biểu thức.** Truy cập trường chỉ bằng JSON Pointer. Khi agent không diễn đạt được, tín hiệu là thêm processor có schema, không phải thêm ngôn ngữ. [ADR 003](../../decisions/003-no-expression-language.md).
6. **Đảm bảo giao hàng.** Trong một lần chạy, message at-least-once theo mô hình một ack cho mỗi batch; `host_llm` idempotent theo khóa `(run_id, step_id, message_id)` do host giữ nên giao lại không trả tiền hai lần; một lần chạy hỏng là hỏng, không giao lại sang lần sau; output hỏng làm lần chạy hỏng trừ khi output đó bật retry tường minh; không buffer bộ nhớ làm yếu đảm bảo.
7. **Quyền là thứ engine suy ra, agent không viết.** `validate` tính quyền từ config, sinh câu tiếng Anh, ghim vào manifest lúc host duyệt; sửa mà quyền rộng ra thì duyệt lại. Ba trần bắt buộc trong pipeline: `llm_calls_per_run`, `runs_per_day`, `run_timeout`; thiếu là validate fail; engine chặn và host chặn lại ở `host_llm`.
8. **Trạng thái.** Engine giữ trạng thái vận hành (cursor dedupe, mốc lịch) trong thư mục host cấp lúc handshake, file JSON theo stream, ghi atomic. Host sở hữu lịch sử lần chạy và kết quả. Tool xem lịch sử là tool của host.
9. **Định dạng pipeline: JSON là chuẩn**, YAML chỉ CLI nhận cho người. JSON Schema xuất theo version; schema tool dùng tập con chung của ba provider.
10. **Tên và giấy phép.** Repo, package và binary `wriven-workflow`; processor gọi về host tên `host_llm` (engine không biết host là ai). LICENSE "Copyright (c) 2026 Hong Truong".
11. **Cô lập: tiến trình con + Seatbelt + proxy, không bằng worker.** Vòng 1 đề xuất một Deno Worker mỗi stream; Hong hỏi về sandbox của macOS và `sandbox-runtime` của Anthropic. Kiểm lại: `sandbox-exec` có sẵn trên macOS, man page ghi "DEPRECATED" và trỏ sang App Sandbox, ngôn ngữ profile không được Apple tài liệu hóa, nhưng Codex CLI đang dùng nó hằng ngày và Seatbelt không lọc mạng theo domain; [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) (Apache-2.0, research preview) giải bài toán domain bằng proxy trên host, Seatbelt chỉ cho nối tới cổng proxy ở localhost, dùng được như thư viện với Bun ≥ 1.4 nhưng đòi `ripgrep` trên máy. App Sandbox cần `.app` đã ký, Wriven chưa có. Quyết định: mỗi lần chạy là một tiến trình con chạy chính binary với cờ `--run`, bọc bằng `sandbox-exec` với profile sinh từ quyền đã suy ra (chỉ đọc binary và thư mục state của stream, không ghi ngoài state, mạng chỉ tới cổng proxy localhost của engine, cấm exec); proxy của engine giữ allowlist host; `host_llm` đi qua stdio, không qua mạng; engine làm watchdog RSS và `run_timeout` rồi kill process group. Tự viết phần profile và proxy, học từ srt và Codex, không kéo srt làm dependency. Nếu `sandbox-exec` không có, câu quyền phải hiện "OS sandbox: unavailable". Chưa chạy thử `sandbox-exec` trên máy Hong trong phiên này (Hong từ chối lệnh thử); "vẫn chạy trên macOS hiện tại" suy từ việc Codex và srt đang dùng. [ADR 004](../../decisions/004-isolation-process-seatbelt-proxy.md).
12. **Lịch khi engine giữ đồng hồ.** Cron 5 trường + IANA tz; chính sách lỡ lịch là trường khai báo `missed: skip | run_once | run_all`, mặc định `run_once`; giờ không tồn tại vì DST chạy ở mốc hợp lệ kế tiếp, giờ trùng lấy lần đầu.
13. **Hủy và tắt.** stdin đóng → drain có hạn (mặc định 10 s) rồi thoát; `run.cancel` hủy in-flight (abort HTTP, gửi `$/cancel` cho `host_llm` đang chờ), lần chạy ghi `cancelled`; host có thể gửi `shutdown` tường minh với hạn riêng.
14. **Mặt tool.** Engine xuất danh sách tool (tên, mô tả, schema tập con) để host chuyển thẳng cho model; mỗi tool ánh xạ 1:1 sang một method JSON-RPC. Duyệt không phải tool: `stream.create`/`stream.update` trả `pending_approval` kèm câu quyền; host gọi `stream.approve` sau khi người dùng bấm.

### Phản biện tám nguyên tắc của brief

- Nguyên tắc 2 (launchd): hạ cấp theo quyết định 1 và theo quyết định 12 của phiên sidecar.
- Nguyên tắc 6 (không tiến trình con): **cấm hẳn** ở v0, không có nhánh "hoặc đưa vào mô hình quyền"; profile Seatbelt cũng cấm exec.
- Nguyên tắc 1 (ẩn cơ chế): siết thành "quyền suy ra, không khai báo" vì thứ agent tự khai có thể nói dối.
- Nguyên tắc 3 (không giữ key): thêm khóa idempotent và `usage` trả về trong hợp đồng `host_llm`.
- Nguyên tắc 5 (không retry): áp cả cho `http_fetch`, không chỉ output.
- Nguyên tắc 8 (kiểm thử được): thêm "`test` phát lại được phản hồi host đã ghi" và "mọi test chạy không cần mạng".

## Sản phẩm sau grilling, một đoạn

Một binary `wriven-workflow` do host sinh, nói JSON-RPC 2.0 qua stdio. Host gửi `initialize` (phiên bản giao thức, ai giữ đồng hồ, thư mục state). Agent gọi tool `workflow_validate_pipeline`, `workflow_test_pipeline`, `workflow_create_stream`; engine suy quyền ra câu tiếng Anh, host hiện cho người dùng duyệt rồi gọi `stream.approve`. Đến giờ, host gọi `run.trigger`; engine sinh một tiến trình con sandbox chạy pipeline, bước LLM gọi ngược `host.llm` kèm khóa idempotent, kết quả về `host.result`; engine trả báo cáo lần chạy có usage. Mọi thứ kiểm thử được bằng host giả, đồng hồ giả, input giả.

## Liên quan

- [Spec](../../specs/README.md), [ADR](../../decisions/README.md), [ticket](../../tickets/README.md), [câu hỏi mở](../../open-questions.md)
- Grilling tiếp theo: [component composition sau v0](composition-components.md)
- Tra cứu ngày 2026-11-03: [runtime](../../research/research-runtime.md), [Benthos/Redpanda Connect/Bento](../../research/research-benthos.md), [tool-calling của ba provider](../../research/research-tool-calling.md)
