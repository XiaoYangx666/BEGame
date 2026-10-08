import { ItemUseAfterEvent, Player, world } from "@minecraft/server";
import { PlayerGroup } from "@begame/core/gamePlayer/playerGroup";
import { BaseMapEventSignal, SubscriptionData } from "../mapEventSignal";

export interface itemData extends SubscriptionData<ItemUseAfterEvent> {
    itemId: string;
    players?: PlayerGroup<any>;
}

export interface itemEventOptions {
    itemId: string;
    players?: PlayerGroup<any>;
}

export class ItemUseEventSignal extends BaseMapEventSignal<
    string,
    ItemUseAfterEvent,
    itemData,
    itemEventOptions
> {
    protected buildKey(options: itemData): string {
        return options.itemId;
    }

    protected buildData(
        callback: (e: ItemUseAfterEvent) => void,
        options: itemData
    ): itemData {
        return {
            callback,
            itemId: options.itemId,
            players: options.players,
        };
    }

    protected extractKey(event: ItemUseAfterEvent): string | null {
        return event.itemStack.typeId ?? null;
    }

    protected filter(data: itemData, event: ItemUseAfterEvent): boolean {
        if (
            event.source instanceof Player &&
            data.players &&
            !data.players.getById(event.source.id)
        ) {
            return false;
        }
        return true;
    }

    protected subscribeNative(cb: (e: ItemUseAfterEvent) => void) {
        world.afterEvents.itemUse.subscribe(cb);
        return cb;
    }

    protected unsubscribeNative(cb: (e: ItemUseAfterEvent) => void) {
        world.afterEvents.itemUse.unsubscribe(cb);
    }
}
