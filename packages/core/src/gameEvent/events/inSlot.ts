import {
    EntityComponentTypes,
    EquipmentSlot,
    ItemStack,
    Player,
} from "@minecraft/server";
import { PlayerGroup } from "@begame/core/gamePlayer/playerGroup";
import { gameServer } from "@begame/core/system/server";
import { Logger } from "@begame/core/utils";
import { CustomEventSignal } from "../eventSignal";
import { Subscription } from "../subscription";
import { IntervalEventSignal } from "./interval";

export interface PlayerItemInSlotEvent {
    item: ItemStack;
    player: Player;
}

export interface PlayerItemInSlotOption {
    slot: EquipmentSlot;
    itemId: string;
    group?: PlayerGroup<any>;
}

interface PlayerItemInSlotData extends PlayerItemInSlotOption {
    callback: (arg0: PlayerItemInSlotEvent) => void;
}

/**当玩家指定槽位出现指定物品时触发 */
export class PlayerItemInSlotEventSignal
    implements CustomEventSignal<PlayerItemInSlotEvent>
{
    private tickSub: Subscription | null = null;
    private readonly map: Map<EquipmentSlot, Set<PlayerItemInSlotData>> =
        new Map();
    private readonly logger = new Logger(this.constructor.name);

    constructor(private readonly intervalEvent: IntervalEventSignal) {}

    subscribe(
        callback: (arg0: PlayerItemInSlotEvent) => void,
        options: PlayerItemInSlotOption
    ): Subscription {
        if (!this.tickSub) {
            this.tickSub = this.intervalEvent.subscribe(this.tick.bind(this));
        }

        const data = {
            ...options,
            callback: callback,
        };
        let slot = this.map.get(options.slot);
        if (!slot) {
            slot = new Set();
            this.map.set(options.slot, slot);
        }
        slot.add(data);
        return this.wrapUnsubscribe(data);
    }

    wrapUnsubscribe(data: PlayerItemInSlotData): Subscription {
        return {
            unsubscribe: () => {
                const slot = this.map.get(data.slot);
                if (!slot) return;
                slot.delete(data);
                if (slot.size == 0) {
                    this.map.delete(data.slot);
                }
                this.cleanUp();
            },
        };
    }

    cleanUp() {
        if (this.map.size == 0 && this.tickSub) {
            this.tickSub?.unsubscribe();
            this.tickSub = null;
        }
    }

    tick() {
        for (const player of gameServer.getAllPlayers()) {
            if (!player.isValid) continue;
            const equipComponent = player.getComponent(
                EntityComponentTypes.Equippable
            );
            if (!equipComponent) continue;
            for (const [equip, list] of this.map.entries()) {
                const item = equipComponent.getEquipment(equip);
                if (!item) continue;
                for (const data of list) {
                    if (
                        item.typeId === data.itemId &&
                        (!data.group || data.group.has(player))
                    ) {
                        try {
                            data.callback({ item, player });
                        } catch (err) {
                            this.logger.error("回调执行错误", err);
                        }
                    }
                }
            }
        }
    }
}
