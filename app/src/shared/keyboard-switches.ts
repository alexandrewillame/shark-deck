/**
 * Magnetic switch models, by the id the firmware stores in magnetism page 252.
 *
 * `provenance: ported-from-vendor` — the ids come from qmk.top's own
 * `MagnetAxisType` enum (a TypeScript enum compiled to `t[t.<name>=<id>]=...`,
 * so they are explicit, not positional) and the colours from the same bundle's
 * switch-colour map, which is what tints its board. Hand-maintained here rather
 * than emitted straight from the extractor, for the same reason
 * `keyboard-travel.ts` is: the extractor cannot be re-run without the vendor
 * bundle.
 *
 * **The ids are unconfirmed on Attack Shark hardware.** The only R85HE snapshot
 * this repo has reads page 252 as all zeros. On qmk.top a zero is not "unset"
 * but "this model's own default switch" (`e === 0 ? getDefaultAxisType() : …`),
 * and for a board whose stock switch is id 0 those are the same reading — so an
 * all-zero page is exactly what a factory R85HE should look like. Everything
 * that writes this page is tagged `inferred` and does a read-back diff. See
 * docs/protocol/keyboard-compx.md.
 *
 * Ids are sparse: the vendor's enum skips 49, 63, 71-72, 74-76, 82, 85, 87,
 * 103-104, 110-112, 114, 118, 124-125, 144-146, 148-154. Those gaps are real —
 * do not renumber.
 */
export interface MagneticSwitchModel {
  /** Wire value for magnetism page 252. */
  id: number;
  /** English name. */
  name: string;
  /** The vendor's Chinese name, kept as the join key back to their data. */
  vendorName: string;
  /** The vendor's own colour code for this model, which is what makes a board
   *  full of mixed switches readable at a glance. Absent for the 15 models
   *  their colour map does not list. */
  color?: string;
}

/**
 * Wire value 0 — "whatever this model ships with".
 *
 * qmk.top resolves a 0 through the model's own default switch rather than
 * treating it as a distinct type, so it must never be offered as a choice of
 * its own: a board picks its default out of `supportedSwitches` like any other.
 */
export const SWITCH_FACTORY_DEFAULT = 0;

/**
 * What one board lets you choose between.
 *
 * qmk.top does NOT offer the whole 127-model id space per board — each device
 * declares a `supportedSwitchTypes` list, and the overwhelmingly common shape
 * is six entries: the board's own stock switch plus the five types that fit the
 * same housing. Offering all 127 was the bug: most of those ids mean nothing to
 * any given firmware, and picking one would write a magnet curve the board has
 * no table for.
 *
 * Ids 0-5 are that canonical six, and they are what every 高特-stock board in
 * the vendor's device list offers.
 */
export const SWITCH_CHOICES_DEFAULT = [0, 1, 2, 3, 4, 5];

export const MAGNETIC_SWITCHES: MagneticSwitchModel[] = [
  { id: 0, name: 'Outemu', vendorName: '高特', color: '#ffea29' },
  { id: 1, name: 'Magnetic Jade', vendorName: '磁玉', color: '#60e849' },
  { id: 2, name: 'Magnetic Jade Pro', vendorName: '磁玉pro', color: '#2effd9' },
  { id: 3, name: 'Magnetic Jade Gaming', vendorName: '磁玉gaming', color: '#b780ff' },
  { id: 4, name: 'Tianwang', vendorName: '天王', color: '#ff5733' },
  { id: 5, name: 'Wan Magnet King', vendorName: '万磁王', color: '#4ca4f4' },
  { id: 6, name: 'Kotai', vendorName: '科泰' },
  { id: 7, name: 'Mechanical', vendorName: '机械轴', color: '#d2b48c' },
  { id: 8, name: 'Magnetic White', vendorName: '磁白轴', color: '#d3d3d3' },
  { id: 9, name: 'Magnetic Jade Custom', vendorName: '磁玉定制', color: '#ff8686' },
  { id: 10, name: 'Wan Magnet King Pro', vendorName: '万磁王pro', color: '#ccff7c' },
  { id: 11, name: 'Tianwang SE', vendorName: '天王SE', color: '#ffb525' },
  { id: 12, name: 'Wan Magnet King RGB', vendorName: '万磁王RGB', color: '#f046ff' },
  { id: 13, name: 'Wan Magnet King POM', vendorName: '万磁王POM', color: '#e260ed' },
  { id: 14, name: 'Magnetic God', vendorName: '磁神轴', color: '#00e5e5' },
  { id: 15, name: 'Kailh', vendorName: '凯华轴', color: '#9370db' },
  { id: 16, name: 'TTC Wan Magnet King', vendorName: 'TTC万磁王', color: '#00ced1' },
  { id: 17, name: 'Phantom Crystal White', vendorName: '幻晶白', color: '#d7fff5' },
  { id: 18, name: 'Magnetic Orange', vendorName: '磁橙', color: '#ff8c00' },
  { id: 19, name: 'Xinxiu', vendorName: '新秀', color: '#98fb98' },
  { id: 20, name: 'Bingwang', vendorName: '兵王', color: '#556b2f' },
  { id: 21, name: 'Aquarius', vendorName: '水瓶座', color: '#00ffff' },
  { id: 22, name: 'Magnetic Pink', vendorName: '磁粉', color: '#c0c0c0' },
  { id: 23, name: 'Ice Mint', vendorName: '冰薄荷', color: '#98fb98' },
  { id: 24, name: 'Star Gravity', vendorName: '星引力', color: '#7b90bc' },
  { id: 25, name: 'Dazzle', vendorName: '炫光', color: '#ffea29' },
  { id: 26, name: 'Peach Crystal', vendorName: '桃晶' },
  { id: 27, name: 'Green Jade', vendorName: '青玉', color: '#a0eecb' },
  { id: 28, name: 'Magnetic Pole', vendorName: '磁极', color: '#ff0000' },
  { id: 29, name: 'Cherry Magnetic Crystal', vendorName: 'Cherry魔晶磁轴', color: '#ff0000' },
  { id: 30, name: 'Purple Crystal', vendorName: '紫晶' },
  { id: 31, name: 'Lightning', vendorName: '闪电', color: '#ffd700' },
  { id: 32, name: 'Phantom Crystal Blue', vendorName: '幻晶蓝', color: '#53dbf7' },
  { id: 33, name: 'Ice Jade', vendorName: '冰玉', color: '#0000ff' },
  { id: 34, name: 'Hejin', vendorName: '禾金', color: '#ffd700' },
  { id: 35, name: 'Low-profile Magnetic Jade', vendorName: '矮磁玉' },
  { id: 36, name: 'Magnetic Rice', vendorName: '磁稻', color: '#deb887' },
  { id: 37, name: 'Haimu Arctic', vendorName: '海木北极轴', color: '#00bfff' },
  { id: 38, name: 'Blue-white Porcelain', vendorName: '青花', color: '#4a90e2' },
  { id: 39, name: 'Outemu Blue Ice', vendorName: '高特蓝冰轴', color: '#00bfff' },
  { id: 40, name: 'White Jade Magnetic', vendorName: '白玉磁轴' },
  { id: 41, name: 'Gateron Storm', vendorName: '高特风暴轴' },
  { id: 42, name: 'Gateron Twilight Butterfly', vendorName: '高特暮蝶轴' },
  { id: 43, name: 'Thanos', vendorName: '灭霸轴', color: '#ac66ee' },
  { id: 44, name: 'Elven King', vendorName: '精灵王轴', color: '#98fb98' },
  { id: 45, name: 'Kailh D30/D32', vendorName: '凯华D30D32', color: '#9370db' },
  { id: 46, name: 'Chixiao', vendorName: '赤霄轴', color: '#fa7e31' },
  { id: 47, name: 'Xuanwu', vendorName: '玄武轴', color: '#7e8cf6' },
  { id: 48, name: 'Zaodi', vendorName: '造迪轴', color: '#ffa326' },
  { id: 50, name: 'Extreme Magnetic Pro', vendorName: '极磁轴PRO', color: '#6ce5e5' },
  { id: 51, name: 'Longhua', vendorName: '龙华轴', color: '#ffea29' },
  { id: 52, name: 'FL Switch', vendorName: 'FL轴' },
  { id: 53, name: 'Ruyi', vendorName: '如意轴', color: '#88f5bd' },
  { id: 54, name: 'Kailh Pink', vendorName: '凯华粉轴', color: '#ffc0cb' },
  { id: 55, name: 'Tianqing', vendorName: '天青轴' },
  { id: 56, name: 'Pegasus Magnetic', vendorName: '天马磁轴', color: '#87ceeb' },
  { id: 57, name: 'Phoenix Silent Magnetic', vendorName: '凤凰静音磁轴', color: '#ff4500' },
  { id: 58, name: 'Extreme Magnetic RGB', vendorName: '极磁轴RGB', color: '#57cae8' },
  { id: 59, name: 'Omega Magnetic', vendorName: '欧米伽磁轴', color: '#e89c57' },
  { id: 60, name: 'KB009E', vendorName: 'KB009E轴', color: '#1e90ff' },
  { id: 61, name: 'Barbie', vendorName: '芭比轴', color: '#f07ca3' },
  { id: 62, name: 'Tianba', vendorName: '天霸轴', color: '#f5a442' },
  { id: 64, name: 'Magnetic Jade Max', vendorName: '磁玉Max', color: '#3cb371' },
  { id: 65, name: 'Star Magnetic', vendorName: '星磁轴', color: '#8a2be2' },
  { id: 66, name: 'Xuanzhao', vendorName: '玄爪轴' },
  { id: 67, name: 'Fengyin', vendorName: '风吟轴' },
  { id: 68, name: 'Purple Flame Magnetic', vendorName: '紫焰磁轴', color: '#9b30ff' },
  { id: 69, name: 'Xuan Magnetic', vendorName: '玄磁轴', color: '#6a5acd' },
  { id: 70, name: 'Glass Jade', vendorName: '璃玉轴', color: '#98d8e8' },
  { id: 73, name: 'Ocean Blue', vendorName: '海蓝轴', color: '#00bfff' },
  { id: 77, name: 'Ice Jade Magnetic', vendorName: '冰玉磁轴', color: '#7ec8e3' },
  { id: 78, name: 'Uncut Jade', vendorName: '璞玉轴' },
  { id: 79, name: 'Ice Jade Pro', vendorName: '冰玉Pro', color: '#48d1cc' },
  { id: 80, name: 'Ice Cream', vendorName: '冰淇淋轴', color: '#ffb6c1' },
  { id: 81, name: 'Magnetic Purple', vendorName: '磁紫轴', color: '#9400d3' },
  { id: 83, name: 'Jiuzi Ruyi', vendorName: '九紫如意', color: '#9400d3' },
  { id: 84, name: 'Shenqi', vendorName: '神启轴', color: '#ffd700' },
  { id: 86, name: 'Mount Tai', vendorName: '泰山轴', color: '#00bfff' },
  { id: 88, name: 'EPOMAKER Linear Magnetic', vendorName: 'EPOMAKER线性磁轴', color: '#b39eff' },
  { id: 89, name: 'Electromagnetic', vendorName: '电磁轴', color: '#4169e1' },
  { id: 90, name: 'Womier', vendorName: 'WOMIER轴', color: '#ff6b9d' },
  { id: 91, name: 'Nuomici Magnetic', vendorName: '糯米糍磁轴', color: '#fff8dc' },
  { id: 92, name: 'White Star', vendorName: '白星', color: '#f0f0f0' },
  { id: 93, name: 'Cloud Jade Magnetic', vendorName: '云玉磁轴', color: '#e0f7fa' },
  { id: 94, name: 'Jellyfish Magnetic', vendorName: '水母磁轴', color: '#e6e6fa' },
  { id: 95, name: 'Starburst', vendorName: '星芒轴', color: '#ceb8ff' },
  { id: 96, name: 'Purple Cloud', vendorName: '紫云轴', color: '#c5b8ff' },
  { id: 97, name: 'Pink Mount Tai', vendorName: '粉泰山轴', color: '#ffd6e6' },
  { id: 98, name: 'Aurora Green', vendorName: '极光绿', color: '#2ee85a' },
  { id: 99, name: 'Magnetic Night', vendorName: '磁夜轴', color: '#4f37bb' },
  { id: 100, name: 'Outemu Bottom-out', vendorName: '高特触底磁轴', color: '#20b2aa' },
  { id: 101, name: 'Outemu Silent', vendorName: '高特静音磁轴', color: '#b0c4de' },
  { id: 102, name: 'Aurora', vendorName: '极光轴', color: '#26a69a' },
  { id: 105, name: 'Ice Silent V2 Magnetic', vendorName: '冰静V2磁轴', color: '#1e88e5' },
  { id: 106, name: 'Serenity', vendorName: '静谧轴', color: '#6b7885' },
  { id: 107, name: 'Cloud Cyan', vendorName: '云青轴', color: '#78c2c4' },
  { id: 108, name: 'Snap Ring', vendorName: '卡簧轴', color: '#c0a16b' },
  { id: 109, name: 'Outemu Ice Jade', vendorName: '高特冰玉', color: '#2e8b57' },
  { id: 113, name: 'Purple Blade Magnetic', vendorName: '紫刃磁轴', color: '#9400d3' },
  { id: 115, name: 'Baoma', vendorName: '宝马轴' },
  { id: 116, name: 'RX120MX', vendorName: 'RX120MX', color: '#e0a09e' },
  { id: 117, name: 'Babao', vendorName: '八宝轴', color: '#7e4647' },
  { id: 119, name: 'Haimu Silent Magnetic', vendorName: '海木静音磁轴', color: '#00bfff' },
  { id: 120, name: 'Peach', vendorName: '水蜜桃轴', color: '#ffb6c1' },
  { id: 121, name: 'Cloud Magnetic', vendorName: '云磁轴', color: '#7794b4' },
  { id: 122, name: 'Tianba AIR', vendorName: '天霸AIR轴', color: '#ffb900' },
  { id: 123, name: 'Blue Jade Magnetic', vendorName: '蓝玉磁轴', color: '#00bfff' },
  { id: 126, name: 'UFO Purple', vendorName: 'UFO磁轴', color: '#9932cc' },
  { id: 127, name: 'OWlab Ti', vendorName: 'OWlab_Ti', color: '#c0c0c0' },
  { id: 128, name: 'Ice Magnetic Ultra', vendorName: '冰磁UltraR2', color: '#00ced1' },
  { id: 129, name: 'WS Flux', vendorName: '八宝钻石磁轴', color: '#e8b4ff' },
  { id: 130, name: 'Gateron Jade MAX', vendorName: '佳达隆MAX', color: '#2e8b57' },
  { id: 131, name: 'Twin Star', vendorName: '双星轴' },
  { id: 132, name: 'Tianqing Pro', vendorName: '天青Pro', color: '#2e8b57' },
  { id: 133, name: 'Haimu Flatfish', vendorName: '海木比目鱼轴', color: '#38bdf8' },
  { id: 134, name: 'Magnetic V2', vendorName: '磁轴V2', color: '#00bfff' },
  { id: 135, name: 'Crystal Domain Magnetic', vendorName: '晶域磁轴', color: '#e5f4ff' },
  { id: 136, name: 'Ice Isle', vendorName: '冰屿轴', color: '#194b9f' },
  { id: 137, name: 'RuiXun Magnetic Amber', vendorName: '睿讯磁珀轴', color: '#d04eb2' },
  { id: 138, name: 'Black Magnetic', vendorName: '黑色磁轴', color: '#4d4d4d' },
  { id: 139, name: 'Twin Jade', vendorName: '双玉', color: '#00bfff' },
  { id: 140, name: 'Outemu Red', vendorName: '高特红', color: '#ff0000' },
  { id: 141, name: 'Tianwang Esports', vendorName: '天王轴电竞', color: '#d82632' },
  { id: 142, name: 'Yingfen Magnetic', vendorName: '樱粉磁轴', color: '#ffc0cb' },
  { id: 143, name: 'GM Pro Magnetic', vendorName: 'GM轴Pro', color: '#26a69a' },
  { id: 147, name: 'URX Magnetic', vendorName: 'URX磁轴', color: '#00bfff' },
  { id: 155, name: 'Hajin Short Magnetic', vendorName: '禾金矮磁轴' },
];

const BY_ID = new Map(MAGNETIC_SWITCHES.map((s) => [s.id, s]));

export const switchModel = (id: number): MagneticSwitchModel | undefined => BY_ID.get(id);

/** A fallback tint for the 15 models the vendor's colour map does not cover,
 *  derived from the id so it is at least stable per model. */
const FALLBACK_COLOR = '#8a93a5';

export const switchColor = (id: number): string => BY_ID.get(id)?.color ?? FALLBACK_COLOR;

/**
 * The switch models a board offers, resolved against its declared list.
 *
 * `defaultId` is what a stored 0 means on this board — see
 * SWITCH_FACTORY_DEFAULT. It is folded into the list so the default switch is
 * pickable by name rather than hiding behind a separate "factory" entry.
 */
export function switchChoices(ids: number[] | undefined): MagneticSwitchModel[] {
  return (ids ?? SWITCH_CHOICES_DEFAULT)
    .map((id) => BY_ID.get(id))
    .filter((s): s is MagneticSwitchModel => !!s);
}
