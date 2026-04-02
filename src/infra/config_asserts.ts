import {tb} from "./tb"
import * as O from "fp-ts/Option";

export const check_item_exist = (item_id: string): O.Option<string> =>
    tb.TbItem.get(item_id)
        ? O.none
        : O.some(`非法的道具, item_id=${item_id}`);

export const check_equip_exist = (equip_id: string): O.Option<string> =>
    tb.TbEquip.get(equip_id)
        ? O.none
        : O.some(`非法的装备, equip_id=${equip_id}`);

export const check_hero_exist = (hero_id: string): O.Option<string> =>
    tb.TbHero.get(hero_id)
        ? O.none
        : O.some(`非法的军团, hero_id=${hero_id}`);
