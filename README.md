DrFed
=====

DrFed is a web-based platform for developing and debugging [ActivityPub]
implementations, built by the team behind [Fedify]. It brings together the
tools you need to diagnose federation failures in one place: fetch and inspect
any ActivityPub object, monitor incoming activities in real time, step through
HTTP signature construction and verification, validate WebFinger and NodeInfo
responses, explore JSON-LD compaction and expansion, and send test activities
to any inbox. The goal is to make it straightforward to answer the question
“why doesn't my server federate with X?”—by showing you exactly which stage
broke, whether that's DNS, TLS, HTTP, signatures, or JSON-LD processing.

[ActivityPub]: https://www.w3.org/TR/activitypub/
[Fedify]: https://fedify.dev/
