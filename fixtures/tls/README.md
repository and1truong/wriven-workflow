# Test certificates

A throwaway CA and a server certificate for `example.com`, `blog.example.org`, `news.example.net`, `other.example` and `evil.example`, used by the fixture HTTPS server in `tests/`. The key is here on purpose: nothing trusts this CA except a test run, which passes it to `fetch` explicitly. No release contains these files.
