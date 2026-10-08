# 房间生命周期：掉线宽限与空房回收

临时小游戏需要自动收尾：玩家掉线后给一段重连宽限，房间真正没人后停局。
BEGame 把这两件事拆成两个可组合的组件，都不包含具体游戏的规则。

## 基本配置

组件挂在游戏的常驻根 State 上，而不是随回合替换的子 State：

```typescript
import { AutoStopComponent, DisconnectTimeoutComponent } from "@begame/core/gameComponent";
import { Duration } from "@begame/core/utils";

this.addComponent(DisconnectTimeoutComponent, {
    timeout: Duration.fromSeconds(30),
    releaseOnTimeout: true,
});
this.addComponent(AutoStopComponent);
```

`DisconnectTimeoutComponent` 对每个掉线玩家独立计时，重连取消超时；它不会把网络掉线直接等同于主动退房。对普通小游戏，超时释放 Participation 后，`AutoStopComponent` 自动处理最后成员离开；在线执行 `playerManager.leave()` 同样能够触发空房回收。已有的 `stopGameWhenEmpty` 仅为兼容保留，新代码不要再使用。

## 检查节奏与 canStop

AutoStop 默认观察当前 Game 的 Participation。成员变化时延迟一个 tick 重新读取成员，避免在退房流程内部重入或误删同 tick 有新玩家加入的房间；另每 10 秒（200 ticks）检查一次，作为漏事件或 `canStop` 条件变化的兜底。

从未有成员加入的空房也会在首次 10 秒检查时被回收，不会永久残留。对初始化完成前可能空置超过 10 秒的游戏，应在入座准备就绪后才挂载 AutoStop；需要永久空房待人的大厅则不要启用自动停止。

`canStop` 可阻止结算期间停局。条件变化后既可主动调用 `reconcile()` 立即重新检查，也会在下一次 10 秒兜底检查中自动重新评估。

## 按 groupSet 限定作用域

若确实需要按组范围停止，可传入 `{ groupSet }`。此时作用域是该 groupSet 当前成员与 Game Participation 的交集，既订阅 group 变化也订阅参与资格变化。

自定义成员资格时，必须**同时**提供 `getMemberIds` 和 `memberChanged`；不要将自定义成员资格与 `groupSet` 混用，以免漏掉成员变化通知。

注意 `PlayerGroup.clearInvalid()` 会真正移除组成员（事件原因 `invalid-purge`），但不会释放 Participation。**有掉线重连宽限的房间不要用会清理离线成员的 group 作为 AutoStop scope**；使用默认 Participation，或让该 group 保留离线成员资格。`PlayerGroupSet.clear()` 只移除包含的 group，不等于清空各组成员。

## 查询在线状态

连接状态实时使用 `Game.server.getPlayer(id)` / `isOnline(id)` 查询服务器在线玩家；`Game.events.connection` 仅广播变化，不维护第二份在线快照。Participation 的 `changed` 只在真正加入、离开时通知，Game teardown 的清理保持静默。

## 相关

- [组件一览](./game-components.md)
- [Game Trace](./game-trace.md)：`DisconnectTimeoutComponent` 的超时生命周期在 trace 里有独立事件族。
