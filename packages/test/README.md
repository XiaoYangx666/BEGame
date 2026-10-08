# @begame/test

A headless host for testing BEGame's real lifecycle implementation in Node. Exercise state transitions, components, player membership, reconnects, timeouts, rollback and cleanup without launching Minecraft.

It does not simulate Minecraft physics, rendering, entity AI, redstone or actual chunk loading.

## Install

```sh
npm install -D @begame/test vitest
```

The declared Vitest peer range is >=5.0.0 <6.0.0.

## Configure Vitest

```ts
import { defineBEGameTestConfig } from "@begame/test/vitest";

export default defineBEGameTestConfig({
    test: { include: ["tests/**/*.test.ts"] },
});
```

The configuration maps Minecraft imports to the test host. Tests execute BEGame's actual framework code. Use BEGameTestEngine to connect/disconnect players, start your game and advance ticks; release the environment after each test.

[Testing guide and examples（中文）](https://github.com/XiaoYangx666/BEGame/blob/HEAD/docs/TEST_ENGINE.md)

Keep installed BEGame packages on the same release version. MIT licensed.
