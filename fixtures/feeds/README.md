# Feed corpus

Hand-written documents shaped like what common generators emit (WordPress, a static-site Atom template, RSS 1.0/RDF, a video site's Atom feed, a newsletter platform). They are not captures of real feeds: no real content was copied, and whether they cover what the live web produces is not verified. Add a capture, sanitized, the first time a real feed breaks the parser.

`*.invalid.xml` must be rejected. Everything else must parse; `tests/feeds.test.ts` holds the expected entry counts.
