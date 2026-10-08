# 游戏规则与运行时分离

本文以斗地主为例，说明如何划分规则核心、BEGame 运行时与表现层。框架能力应可复用于其他游戏，具体牌局规则与视觉实现由游戏项目持有。

## 目标

- 斗地主规则与 Minecraft / BEGame 完全解耦，可在普通 TypeScript 环境独立测试。
- BEGame 负责游戏实例、玩家分配、生命周期、运行时状态、组件、事件和 Runner。
- 斗地主表现层独立于规则核心，现有 `visual_controller` 只作为视觉投影，不作为权威牌局状态。
- 支持同类多实例、多局 Session、脚本重载恢复，并为后续掉线重绑定保留空间。

## 依赖方向

```text
Minecraft / BEGame
        |
        v
Doudizhu Adapter + Presentation
        |
        v
DDZ Core (pure TypeScript)
```

`DDZ Core` 不允许依赖：

- `@minecraft/server`
- `@begame/core`
- Entity / Player / GameState / GameComponent
- 动画、音效、Viewer、按钮和 UI 临时状态

## 两类状态

必须区分运行时状态和权威牌局状态。

### SAPI GameState

用于表达运行阶段和管理运行时资源，例如：

- Waiting
- Bidding
- Playing
- Settlement
- 对应阶段的 GameComponent、EventSubscription、Runner

这些对象不要求可序列化，也不直接作为对局存档。

### DDZ MatchState / RoundState

用于表达游戏事实，例如：

- 三家手牌
- 地主
- 当前行动座位
- 上一手牌
- 连续 Pass 次数
- 倍数
- 当前局数和累计比分

这些数据必须从一开始就保持 JSON 可序列化，并作为 Snapshot / Restore 的基础。

恢复时由权威状态重新构造 SAPI GameState，而不是序列化 GameState 实例。

## GameEngine 生命周期约定

一个 `DoudizhuGameEngine` 表示一张牌桌上的一次 Session，而不是单独一局牌。

```text
DoudizhuGameEngine
  -> Round 1
  -> Settlement
  -> Round 2
  -> Settlement
  -> ...
  -> players leave / session ends
```

因此单局结束不调用 `stopGame()`。

## Stable Game Type

斗地主首先验证出的框架缺口是：长期存档不能依赖 `class.name` 作为永久游戏类型。

`GameManager` 现在支持游戏类声明可选的静态 `gameType`：

```ts
export class DoudizhuGame extends DoudizhuModule.Engine {
    static readonly gameType = "doudizhu";
}
```

之后：

```text
DoudizhuGame + tag=table_01
=> doudizhu:table_01
```

未声明 `gameType` 的现有游戏仍继续使用 `class.name`，因此不破坏旧项目。显式 `gameType` 必须是非空字符串且不能包含 `:`。

这个标识后续会同时用于 Snapshot 元数据和 Restore Registry，而不是只为斗地主做特判。
