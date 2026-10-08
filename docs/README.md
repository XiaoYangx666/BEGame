# BEGame documentation

[English overview](../README.md) · [中文简介](../README.zh-CN.md)

Start with setup, learn the lifecycle model, then choose the guides your game needs. The overview and setup guide are in English; gameplay tutorials and some references are in Chinese.

## Start here

1. [Getting started](./getting-started.md) — dependencies, initialization and the path to a first game.
2. [Architecture](./architecture.md) — ownership, states, components and participation.
3. [Game authoring tutorial（中文）](../tutorial/使用教程.md) — create a module, engine and states.
4. [Worked example（中文）](../tutorial/实战/实战1.md) — build a minigame step by step.

## Build a game

| Guide | Use it for |
| --- | --- |
| [Components（中文）](./game-components.md) | Find reusable behavior |
| [Room lifecycle（中文）](./room-lifecycle.md) | Disconnect grace periods and empty-room cleanup |
| [Events（中文）](../tutorial/GameEvents.md) | Subscribe to game signals |
| [Utilities（中文）](../tutorial/utils.md) | Common helpers |
| [Headless testing（中文）](./TEST_ENGINE.md) | Exercise lifecycle behavior in Node |

## Inspect and ship

| Guide | Use it for |
| --- | --- |
| [Game Trace](./game-trace.md) | Record, retain and inspect sessions |
| [Observatory（中文）](../packages/observatory/README.md) | Install the CLI, configure transports and archives |
| [BDS server-net（中文）](./server-net-export.md) | Connect a dedicated server |
| [Packaging](./packaging.md) | Understand bundle boundaries and tree-shaking |
| [Release guide](./releasing.md) | Validate and publish the npm package set |
| [Release notes draft](./release-notes.md) | Candidate scope, migration and validation |

Package-specific installation details live in each [package README](../README.md#packages). Public signatures and defaults are defined by the shipped TypeScript declarations; examples explain the intended usage.

## Design reference

[Separating rules from runtime（中文）](./ddz-support.md) describes reusable integration principles drawn from Dou Dizhu. It is design guidance, not an installation prerequisite or a release acceptance report.
