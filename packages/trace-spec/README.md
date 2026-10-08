# @begame/trace-spec

The shared BEGame Trace vocabulary: event IDs, value/schema types, session shapes and error markers. This package has no dependencies or module-level side effects.

Core and Trace use the same vocabulary without making core depend on the Trace implementation.

## Install

```sh
npm install @begame/trace-spec
```

Most game authors receive this package transitively through core or Trace. Install it directly when building integrations that use its vocabulary.

```ts
import { BuiltinTraceEventType, TRACE_MAGIC } from "@begame/trace-spec";
```

[Trace guide](https://github.com/XiaoYangx666/SAPI-Game/blob/HEAD/docs/game-trace.md)

Keep installed BEGame packages on the same release version. MIT licensed.
