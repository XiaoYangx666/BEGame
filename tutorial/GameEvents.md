# GameEvents

> 为了方便游戏开发，SAPI-Game 内置了一些包装事件，和 sapi 的事件格式基本保持一致。

## 如何订阅事件

在 component 或 state 中订阅使用

```ts
this.subscribe(事件, 回调函数, 订阅参数);
```

其中事件可以是游戏原生事件，也可以是框架事件。框架事件可以通过`Game.events.xxx`来访问

例如:

```ts
//订阅游戏原生事件
import { world } from "@minecraft/server";
this.subscribe(world.beforeEvents.effectAdd, (e) => {
    console.log(e.duration.toString());
});
```

```ts
//订阅框架事件
import { Game } from "sapi-game/main";
this.subscribe(
    Game.events.interval,
    () => {
        console.log("10tick过去了");
    },
    new Duration(10)
);
```

### 示例

```ts
export class KcqdDaemon extends GameComponent<KcqdMainState> {
    override onAttach(): void {
        //tick
        this.subscribe(Game.events.interval, () => {
            //显示烤肠所在的人
            const sausages = this.state
                .getPlayersWithSauage()
                .map(
                    (p) =>
                        `${p.name}(${Vector3Utils.toString(
                            Vector3Utils.intPos(p.player!.location)
                        )})`
                );
            this.context.players.actionbar(
                sausages.length == 0 ? "无" : sausages.join(",")
            );
        });
    }
}
```

## 事件列表

-   [interval](#interval)
-   [buttonPush](#buttonpush)
-   [signClick](#signclick)
-   [itemUse](#itemuse)
-   [region](#region)
-   [onBlock](#onblock)
-   [inSlot](#inslot)

所有下述事件都通过`Game.events.xxx`来访问

---

### interval

循环事件，会按指定间隔重复执行（默认每 tick 执行）。

#### 回调

`() => void`

#### 订阅参数

`interval?: Duration

> 可选参数，用于指定循环间隔，默认每 tick 执行。

#### 示例

小鸡大战牧人的循环逻辑

```ts
this.subscribe(Game.events.interval, () => {
    this.tpChickenToPlayer();
    this.giveEffectToChickens();
    this.spawnPoint();
    this.checkChickenWin();
});
```

---

### buttonPush

监听游戏中指定维度指定位置的按钮被玩家按下的事件。

#### 回调

`(event: ButtonPushAfterEvent) => void`

> ButtonPushAfterEvent 为游戏原生事件对象，包含按钮事件的所有信息。

#### 订阅参数

`options: ButtonPushEventOptions`

```ts
interface ButtonPushEventOptions {
    dimensionId: DimensionIds; // 按钮所在维度
    loc: [number, number, number]; // 按钮坐标 [x, y, z]
    players?: PlayerGroup<any>; // 可选：仅这些玩家触发事件
    sourceType?: string; // 可选：限定触发按钮的实体类型，默认任意
}
```

#### 示例

烤肠派对大厅的开门按钮

```ts
this.subscribe(Game.events.buttonPush, () => this.openDoor(), {
    loc: [-158, -58, -385],
    dimensionId: DimensionIds.Overworld,
});
```

---

### signClick

监听游戏中指定维度指定位置的牌子被玩家点击的事件。

#### 回调

`(event: PlayerInteractWithBlockBeforeEvent)=>void`

#### 订阅参数

`options: SignClickEventOptions`

```ts
interface SignClickEventOptions {
    dimensionId: DimensionIds; //牌子维度
    loc: Vector3; //牌子位置
    players?: PlayerGroup<any>; // 可选：仅这些玩家触发事件
    clickInterval?: number; //点击冷却(默认1tick)，0表示无冷却
}
```

#### 示例

某个游戏的开始牌子

```ts
this.subscribe(Game.events.signClick, (t) => this.handleStart(t), {
    dimensionId: DimensionIds.Overworld,
    loc: { x: 872, y: -51, z: 945 },
    clickInterval: 5,
});
```

---

### itemUse

监听玩家使用指定 id 的物品。可限制玩家组。

#### 回调

`(event: ItemUseAfterEvent) => void`

#### 订阅参数

`options: itemEventOptions`

```ts
interface itemEventOptions {
    itemId: string; //物品id
    players?: PlayerGroup<any>; //限制触发的玩家组
}
```

#### 示例

狼人杀投票逻辑

```ts
this.subscribe(
    Game.events.itemUse,
    (t) => {
        const p = t.source;
        const gamePlayer = this.context.players.getById(p.id);
        if (gamePlayer) {
            this.showForm(gamePlayer);
        }
    },
    { itemId: "werewolf:vote", players: this.context.players }
);
```

---

### region

监听玩家进入/离开指定区域

#### 回调

`(event: PlayerRegionEvent) => void`

```ts
interface PlayerRegionEvent {
    readonly player: Player; //触发事件的玩家
    readonly type: RegionEventType; //事件类型
    readonly region: GameRegion; //区域
}
```

```ts
enum RegionEventType {
    Enter = "enter",
    Leave = "leave",
}
```

#### 订阅参数

`region:` GameRegion

#### 示例

色盲派对复活逻辑

```ts
this.subscribe(
    Game.events.region,
    (t) => {
        if (t.type != RegionEventType.Enter) return;
        const gamePlayer = this.context.players.getById(t.player.id);
        if (!gamePlayer) return;
        if (gamePlayer.relifeTimes > 0 && !gamePlayer.isRelife) {
            gamePlayer.isRelife = true;
            gamePlayer.relifeTimes--;
            gamePlayer.sendMessage(
                `你将在下回合复活(剩余复活次数${gamePlayer.relifeTimes})`
            );
        }
    },
    new SphereRegion(
        DimensionIds.Overworld,
        { x: 114.5, y: -56.5, z: -161.5 },
        5
    )
);
```

---

### onBlock

监听玩家处于指定 id 的方块上。

#### 回调

`(arg0: PlayerOnBlockEvent) => void`

```ts
interface PlayerOnBlockEvent {
    player: Player;
    block: Block;
}
```

#### 订阅参数

`options?: PlayerOnBlockEventOption`

```ts
interface PlayerOnBlockEventOption {
    group?: PlayerGroup<any>; //触发事件的玩家组
    typeIds?: string[]; // 触发事件的方块id列表(单个或多个)
}
```

#### 示例

代码片段为你的跑酷我来造获胜条件

```ts
//踩钻石块就赢
this.subscribe(
    Game.events.onBlock,
    (t) => {
        if (
            this.state.team.getById(t.player.id) &&
            t.player.getGameMode() !== GameMode.Spectator &&
            !this.isEnded
        ) {
            this.onWin();
        }
    },
    { group: this.state.team, typeIds: ["minecraft:diamond_block"] }
);
```

---

### inSlot

指定物品在玩家指定栏位时触发

#### 回调

`(arg0: PlayerItemInSlotEvent) => void`

```ts
interface PlayerItemInSlotEvent {
    item: ItemStack;
    player: Player;
}
```

#### 订阅参数

`options: PlayerItemInSlotOption`

```ts
interface PlayerItemInSlotOption {
    slot: EquipmentSlot; //槽位
    itemId: string; //物品id
    group?: PlayerGroup<any>; //指定玩家组
}
```

#### 示例

代码片段为电梯猫生命显示

```ts
//生命显示
this.subscribe(
    Game.events.inSlot,
    (t) => {
        const p = this.context.mouse.getById(t.player.id);
        if (p) {
            p.actionbar(`剩余 §c${p.lives}§r 条命`);
        }
    },
    {
        slot: EquipmentSlot.Mainhand,
        itemId: "minecraft:redstone_block",
        group: this.context.mouse,
    }
);
```
