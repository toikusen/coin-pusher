# 機台外殼設計（Cabinet Shell）

**日期**：2026-09-08
**修訂**：2026-09-08（第五版。二：codex 驗證。三：Blender 試渲，§12。四：遊戲實跑，§13。五：太素，把光挪到看得見的位置並加上動態，§14。六：檯面藝術，以及一個量完決定不做的東西，§15。七：發射器，§16。八：硬幣配色，§17）
**範圍**：以 Blender 程序化建模重做 `public/models/cabinet.glb` 與 `public/models/launcher.glb`，取代現有的 Sketchfab 下載模型。物理幾何完全不動，three.js 程序化家具保留為 fallback。

---

## 1. 動機

現有 `cabinet.glb` 是 Sketchfab 的「Silver Skis」下載模型，尺寸與軸向都不是為這台機器做的，靠六個 config key 硬對位：

- `cabinetYaw` 轉四分之一圈，因為匯出器的正面朝 −X
- `cabinetFitPart: 'coin_area'` 把模型的幣床對齊我們的檯面，而不是按整體尺寸縮放
- `cabinetOffset` / `cabinetWidthFit` 手調殘差
- `cabinetHide` 七條字串，逐一關掉模型自帶的檯面、推板、車道、壓克力隔板與四支角柱 —— 每一個都跟真正接物理的幾何打架
- `cabinetGlow` 在載入後 clone 材質改 emissive，因為下載的招牌只被室內光照到，看起來像關機

外加 `loadCabinet()` 裡一整段 DEV 專用的 raycast 診斷，存在的唯一理由是「要擴充 `cabinetHide` 就得先知道模型哪裡侵入檯面」。

自己授權模型可以讓上面全部消失：原點與軸向一開始就是對的，沒有東西需要隱藏，發光烤進材質。

## 2. 視覺方向

沿用專案背景圖的風格（`public/backdrop/hall.jpg`，生成 prompt 見附錄 A）：futuristic neon casino hall、cyberpunk、teal 與 gold 霓虹燈條、深藍近黑建築、拋光反射地面帶金色格線、側牆垂直光柱、天花板同心發光環。

對映到既有 `PALETTE`：

| Reference 元素 | PALETTE | 機台上的對應 |
|---|---|---|
| dark navy-black architecture | `shellDeep 0x081020` | 機身主色，高光澤 |
| teal neon strip | `mint 0x00c8b4` | 側牆垂直光柱、前窗開口內緣光溝 |
| gold neon strip、floor grid lines | `gold 0xf2c94c` | 水平飾條、基座發光環 |
| concentric glowing rings（天花板） | — | marquee 主視覺 |

三條由 reference prompt 直接推出的規則：

1. **marquee 不放任何文字或 logo。** 原始 prompt 明確寫 `no text, no logos`。marquee 走天花板那組同心發光環的立體版，不是招牌。現有 `createHeadboardTexture()` 的文字紋理與 `createBadgeTexture()` 的 CP 六角徽章只留給 procedural fallback 使用。
2. **幾乎不用貼圖。** reference 的質感是「拋光深色材質 + 自發光燈條」，用 PBR 參數（roughness / metalness / emissive）就做完了，不需要 albedo 貼圖。
3. **正面完全左右對稱**，與背景的單一消失點中軸構圖一致。

## 3. 取景的既成事實

以現行相機（`CoinPusher.js:261`，位置 `(0, 5.4, −9.4)`，`lookAt(0, 0.4, 0.6)`，垂直 fov 62°，下俯 26.57°）量測。fov 是垂直的，所以垂直可見帶與視窗長寬比無關。

| z 位置 | 畫面上緣 y | 畫面下緣 y |
|---|---|---|
| `−7.37` chuteLip | 5.56 | 2.21 |
| `−6.30` 出幣槽 `chuteZ()` | 5.64 | 0.52 |
| `−5.90` launcher | 5.67 | −0.11 |
| `−4.70` 機台前面 | 5.76 | −2.00 |
| `−4.00` 拉霸機 | 5.82 | −3.10 |
| `0` 檯面中段 | 6.13 | −9.39 |
| `4.36` `playfieldBackZ` | 6.47 | −16.25 |
| `5.00` 外殼後緣 | 6.52 | −17.26 |

三個結論主導了投資分配：

1. **出幣盤、按鈕、投幣口完全在畫面外。** 前面板 `y < −2.0` 落在畫面外；出幣槽在 `y = −2.4`、`z = −6.30`，而畫面下緣在那個 z 是 `y = 0.52`，差得更遠。
2. **內縮基座的金色發光環正前方看不到**（`y = −2.65` 低於前緣下緣 `−2.00`），但機台中段往後的側面看得到（`z = 0` 時下緣 `−9.39`）。所以那圈光只做側面與後方三邊。
3. **marquee 是最值得投資的地方。** 後方畫面上緣到 `y = 6.51`，而現有 headboard 頂只到 `3.5` —— 中間三個單位的畫面完全空著。`CoinPusher.js:253` 那句「marquee 已經被裁掉」講的是下載模型被 `coin_area` 撐大後的招牌，不是自己授權的尺寸。

### 3.1 水平餘裕

畫面半寬佔比（1.0 = 剛到畫面邊緣）：

| 點 | 21:9 | 16:9 | 4:3 | 1:1 |
|---|---|---|---|---|
| 前玻璃頂角 `\|x\|=4.25` | 0.54 | 0.71 | 0.95 | 1.27 |
| 角柱外緣 `\|x\|=4.53` | 0.56 | 0.74 | 0.99 | 1.32 |
| 本設計外殼 `\|x\|=4.85` | 0.57 | 0.75 | 1.00 | 1.34 |

外殼做到 `|x| = 4.85` 幾乎不花錢（16:9 從 0.74 到 0.75）。正方與直立視窗今天就已經裁掉前玻璃頂角，這不是本設計新增的問題。

`config.js:28` 寫「玻璃頂落在畫面半寬的 0.81」，在現行相機下量不到這個值（4:3 是 0.95、16:9 是 0.71）。`CoinPusher.js:248` 記錄了相機從 39°／fov 56／standoff 10.4 改成 27°／fov 62／9.4，那句 0.81 很可能是改相機前的數字。**這是推論，未經驗證** —— 本設計不依賴它，只依賴上表的實測值。

### 3.2 marquee 與拉霸機的螢幕重疊

拉霸機在 `z = −4`（機台前方、離相機近），螢幕上佔中央約 60% 寬；marquee 在 `z ≈ 5`。所以 marquee 的中央會被拉霸機遮住。同心環是空心的，這個遮擋不礙事 —— 反而是選同心環而非實心招牌的另一個理由。

### 3.3 兩處與程式註解不符的數字

本設計的量測與兩條既有註解衝突。兩處都經過重算，**本文件的數字才是現行常數下的正確值**，註解未修（不在本設計範圍內）：

| 註解 | 註解說法 | 現行常數的實際值 | 差異來源 |
|---|---|---|---|
| `config.js:28` | 前玻璃頂落在畫面半寬 `0.81` | 4:3 是 `0.95`、16:9 是 `0.71` | 相機從 39°／fov 56 改為 27°／fov 62（`CoinPusher.js:248` 自述）—— **推論** |
| `config.js:249` | 飛幣頂點約 `3.55`、在 `z −0.95` | `3.19`、在 `z 0.62` | `launcherLandingY` 從 `1.24` 改為 `0.76`；`lerp(0.06, 1.24, 0.75) = 0.945` ≈ 註解的 `0.95` —— **已驗證** |

## 4. 整合方式

### 4.1 採用：單一 GLB、模型端授權座標、材質烤進 glTF

Blender script 產出一顆 `cabinet.glb`，原點與軸向直接對齊世界座標，PBR 材質與自發光烤進檔案。`loadCabinet()` 只保留一段最小 traverse（見 §9.3）。

### 4.2 未採用的替代方案

**GLB 只給幾何、材質在 three.js 端套 PALETTE。** 好處是改一個 hex 全部跟著變，代價是要多維護一張節點名到材質的對映表。`PALETTE` 已經穩定，這層間接目前沒有需求（YAGNI）。

**拆多檔（body / marquee / plinth 分開）。** 沒有獨立替換單一部件的需求。

### 4.3 Palette 單一來源

`tools/build_cabinet.py` 用 regex 從 `src/game/config.js` 讀 `PALETTE` 的 hex 值，不在 Python 端重打一份。

## 5. 座標授權規則

### 5.1 原點與軸向

`layoutGeometry()`（`CoinPusher.js:804`，mount 在 `826–827`）把 mount 放在 `z = MACHINE_GEOMETRY_DEFAULTS.lowerCenterZ = −0.17`，並設 `scale.z = lowerLength / 9.06`。因此：

**模型原點 = 世界 `(0, 0, −0.17)`。** 這樣 `cabinetOffset` 不需要存在。

Blender 是 Z-up、glTF 是 Y-up，換算：

```
bx =  wx
by = -(wz + 0.17)
bz =  wy
```

匯出用 `+Y up`（glTF 匯出器預設），`cabinetYaw` 不需要存在。

### 5.2 local z ±4.53 是釘死的錨點

模型的 local z 與世界 z 的關係，在任何幾何設定下都是：

```
z_world = lowerCenterZ + (lowerLength / 9.06) × z_local
```

因為 `9.06 / 2 = 4.53`，所以：

**`z_local = −4.53` 恆等於 `lowerFrontZ`，`z_local = +4.53` 恆等於 `lowerBackZ`** —— 與幾何面板的設定無關。

這一點是外殼前緣的定位依據。`machineGeometryFor()`（`config.js:585`）有一條推導：

```js
const lowerLength = Math.min(
  clampGeometry('lowerLength', saved.lowerLength),
  2 * (lowerCenterZ - GAME.launcherMuzzleZ),
);
```

它保證床前緣永遠不越過發射器槍口 `−5.2`。所以**任何 `z_local ≥ −4.53` 的部件都自動繼承這個保證**。

### 5.3 為什麼前緣必須齊平在 −4.53

第一版把前面板放在 world `−5.05`（local `−4.88`）。四個幾何極值實測：

| `lowerCenterZ` | `lowerLength` | `scale.z` | 床前緣 | 前面板 @ local −4.88 | 前面板 @ local −4.53 |
|---|---|---|---|---|---|
| −0.45 | 7.60 | 0.8389 | −4.25 | −4.54 | −4.25 |
| −0.45 | 9.50 | 1.0486 | −5.20 | −5.57 | −5.20 |
| +1.20 | 7.60 | 0.8389 | −2.60 | −2.89 | −2.60 |
| +1.20 | 12.80 | 1.4128 | −5.20 | **−5.69** | −5.20 |

`lowerLength` 的可達上限是 `min(13, 2×(lowerCenterZ + 5.2))`，所以 `centre = +1.2` 時可達 `12.80`。在那一格，local `−4.88` 的前面板跑到 `−5.69`，比槍口 `−5.20` 還前面 `0.49` —— **硬幣會生成在前面板內部**。這不是測試覆蓋率問題，是設計缺陷。

齊平在 local `−4.53` 之後，四個極值全部精準落在床前緣，零穿透。

### 5.4 發射器的實際佔位

`buildLauncher()`（`CoinPusher.js:1953`）：

```js
model.position.z += muzzleLocalZ - bounds.max.z;
```

槍管指向 `+Z`（朝機台內），所以**槍口就是模型的最後緣**，被釘在 `launcherMuzzleZ = −5.2`。整支槍佔 `z ∈ [−6.82, −5.20]`，全部在床前緣之前。

因此外殼前緣齊平在床前緣時，與發射器恰好相切、零重疊，不需要留額外餘裕，也不需要為它挖凹槽。`config.js:223` 的註解也確認這是刻意的：「at the old −5.28/−0.6 the gun sat below the frame's bottom edge and behind the cabinet's front panel」。

### 5.5 後緣餘裕

`addHall()`（`CoinPusher.js:1529`）把背景平面放在 `HALL_Z = 11`。外殼最後緣 local `5.42`，在最極端的 `centre = +1.2, scale = 1.4128` 下到 world `8.86`，距背景平面還有 `2.14`。無虞。

## 6. 淨空封包

封包分三類，因為它們的可驗證方式不同 —— 這是第一版的錯誤：把三類混在一起當成「AABB 相交測試」，其中兩類無法那樣測。

### 6.1 A 類：實體封包（可做 AABB 相交測試）

都是封閉的 3D 體積，模型節點的 AABB 不得與之相交。

| 封包 | 範圍 | 依據 |
|---|---|---|
| 硬幣活動區 | `\|x\| ≤ 4.0`，全 y、全 z | `playfieldHalfWidth` |
| 側玻璃／角柱 | `\|x\| ≤ 4.53`，`y −0.29…2.27`，床的全長 | glass 外面 4.25、posts 外緣 4.525、neon bar 頂 2.27 |
| 撒幣通道 | `y ≤ 4.35`，`z dropZoneZ ± 0.4`，`\|x\| ≤ 2.85` | `coinRainY + 0.4`、`coinRainDepth/2`、`coinRainHalfWidth` |
| 寶箱掉落 | `y ≤ 3.40`，`z scraperZ ± 0.45`，`\|x\| ≤ 2.85` | `chestStartY`、`chestDropZ()`、`CHEST_DROP_HALF_WIDTH` |

`dropZoneZ` 與 `scraperZ` 都由 `machineGeometryFor()` 導出，會隨幾何面板移動 —— 測試必須從幾何算，不能寫死 `2.56` / `4.04`。

### 6.2 B 類：飛幣弧線（取樣點測試）

弧線是一條路徑，不是體積。把它當體積會過度保守（弧線下方整塊都被禁掉），所以改為沿路徑取樣，斷言每個取樣點不落在任何節點的 AABB 內。

`updateLaunching()`（`CoinPusher.js:2052`）：

```
eased = 1 − (1 − t)²
z(t)  = lerp(launcherMuzzleZ, dropZoneZ, eased)
y(t)  = lerp(launcherMuzzleY, launcherLandingY, eased) + sin(πt) × launcherArcHeight
```

`launcherTargetFor()`（`rules.js:129`）的 `z` 固定回傳 `GAME.dropZoneZ`，只有 `x` 隨 aim 變。所以路徑在 ZY 平面上是唯一的一條，橫向掃 `|x| ≤ launcherTravelHalfWidth = 3.45`。

預設幾何（`dropZoneZ = 2.56`）下：

| t | z | y |
|---|---|---|
| 0.0 | −5.20 | 0.06 |
| 0.2 | −2.41 | 1.84 |
| 0.3 | −1.24 | 2.52 |
| 0.4 | −0.23 | 2.98 |
| **0.5** | **0.62** | **3.19** |
| 0.6 | 1.32 | 3.12 |
| 0.8 | 2.25 | 2.26 |
| 1.0 | 2.56 | 0.76 |

硬幣在 `z ≈ −1.7` 到 `2.4` 之間飛在玻璃頂（2.15）與 neon bar（2.2）**上方**，頂點 `y = 3.19`。

**這條路徑上方不能加任何頂蓋、環燈或橫樑。** 本設計因此沒有任何跨越檯面的部件 —— 前窗開口的上緣（`y = 2.20`）是唯一接近它的地方，而弧線在開口所在的 z（約 `−4.5`）只有 `y ≈ 0.3`。

### 6.3 C 類：取景邊界（設計指引，不做斷言）

§3 的相機可見帶是「應該看得到」的設計指引，不是「不得侵入」的硬約束，所以不寫成測試斷言。相機一改，斷言就會失效，而失效不代表模型壞了。

## 7. 零件表

**所有 z 都是模型 local z**（authoring 座標，`tools/build_cabinet.py` 直接用這組數字）。世界 z 在預設幾何下是 `z_local − 0.17`。x 與 y 是世界座標（不隨幾何面板變）。

第一版有三個部件是中空的（`window_frame`、開了窗的 `front_panel`、U 型 `plinth_glow`），它們的 AABB 會把洞算成實體，測試必然誤判。本版把它們拆成獨立的實心邊段 —— 每一段的 AABB 都是緊的。

### 7.1 機身

| 節點 | local z | 世界 y | 世界 x | 材質 |
|---|---|---|---|---|
| `shell_side_L` / `shell_side_R` | `−4.53…5.22` | `−2.55…2.60` | `\|x\| 4.55…4.85` | `shell_dark` |
| `shell_light_teal_{1..4}_{L,R}` ×8 | 中心 `{−3.23, −0.93, 1.37, 3.67}`，寬 `0.10` | `−1.60…2.35` | `\|x\| 4.83…4.87` | `neon_teal` |
| `trim_gold_rail_{lo,hi}_{L,R}` ×4 | `−4.53…5.22` 貫穿 | `lo` 中心 `0.00`、`hi` 中心 `2.45`，高 `0.05` | `\|x\| 4.84…4.86` | `trim_gold` |
| `back_shell` | `5.22…5.42` | `−2.55…3.30` | `\|x\| ≤ 4.85` | `shell_dark` |

### 7.2 前臉（開口 `\|x\| ≤ 4.55`、`y 0.00…2.20`）

前面板拆成四段實心塊，圍出開口。開口下緣就是床面 `y = 0`。

| 節點 | local z | 世界 y | 世界 x | 材質 |
|---|---|---|---|---|
| `front_bezel_top` | `−4.53…−4.33` | `2.20…2.60` | `\|x\| ≤ 4.85` | `shell_dark` |
| `front_bezel_L` / `front_bezel_R` | `−4.53…−4.33` | `−2.00…2.60` | `\|x\| 4.55…4.85` | `shell_dark` |
| `front_panel_lower` | `−4.53…−4.33` | `−2.00…0.00` | `\|x\| ≤ 4.85` | `shell_dark` |
| `front_glow_top` | `−4.53…−4.50` | `2.16…2.20` | `\|x\| ≤ 4.55` | `neon_teal` |
| `front_glow_L` / `front_glow_R` | `−4.53…−4.50` | `0.00…2.20` | `\|x\| 4.51…4.55` | `neon_teal` |

前緣一圈 45° 導角落在 `front_bezel_*` 的 `z = −4.53` 面上，往內側倒。

`front_panel_lower` 完全在畫面外（§3 結論 1），所以不做任何細節，就是一塊平板。

### 7.3 基座

| 節點 | local z | 世界 y | 世界 x | 材質 |
|---|---|---|---|---|
| `plinth` | `−4.43…4.97` | `−2.76…−2.55` | `\|x\| ≤ 4.35` | `shell_dark` |
| `plinth_glow_L` / `plinth_glow_R` | `−4.43…4.97` | `−2.52…−2.44` | `\|x\| 4.84…4.86` | `neon_gold` |

`plinth` 外緣 `4.35` 比機身外緣 `4.85` 內縮 `0.50`，機身外緣因此懸出。

發光線在**機身外表面**，與上方兩條金線同一個平面（`|x| 4.84…4.86`），不在基座的內縮面上。第二版放在內縮面（`4.35…4.55`），試渲後完全看不見：只有 `0.08` 高，又埋在機身 `0.30` 的懸出後面，而且這裡沒有任何東西會被它照亮 —— emissive 是一個玩家必須直接看得到的表面，不是光源。齊平在外表面上，讀起來就是背景圖裡盆栽底座那條基線。

**沒有後方那一段。** 第二版是 U 形三邊，但相機永遠在機台正前方，後段是永遠沒人看得到的幾何。

**沒有 `payout_housing`。** 第一版有，理由見 §7.5。

### 7.4 marquee

底板是矩形面板，四圈是**橢圓**路徑的等徑管。

| 節點 | 中心 | 半徑 | 材質 |
|---|---|---|---|
| `marquee_panel` | `\|x\| ≤ 4.70`，`y 3.30…5.40`，local `5.22…5.42` | 邊緣導圓 `0.09`（3 段） | `shell_dark` |
| `marquee_ring_teal` | `(0, 4.35, local 5.19)` | `rx 4.30` / `ry 0.92`，管半徑 `0.020` | `neon_teal` |
| `marquee_ring_g1` | 同上 | `rx 3.60` / `ry 0.77`，管半徑 `0.0275` | `neon_gold` |
| `marquee_ring_g2` | 同上 | `rx 2.50` / `ry 0.54`，管半徑 `0.0275` | `neon_gold` |
| `marquee_ring_g3` | 同上 | `rx 1.50` / `ry 0.32`，管半徑 `0.0275` | `neon_gold` |

- **平面**：全部在世界 XY 平面上，法線朝 `−Z`（面向玩家）。
- **`ry / rx = 0.214`**，四圈統一，所以四圈看起來是同一組同心橢圓。
- 環比底盤前面 `0.03`（local `5.19` vs 底盤前面 `5.22`）。

**底板是矩形，不是第二版的橢圓盤。** 橢圓盤抵在平頂的背牆上只有 `x = 0` 一點接觸：試渲出來 marquee 懸在空中，縫隙往兩端張開到短半軸的整個 `1.05`。矩形面板的下緣就是背牆的上緣，全寬貼合，而同心環是視覺主體，掛在什麼形狀上都一樣讀。

驗算每圈的垂直範圍都落在底板 `y 3.30…5.40` 內：

| 環 | `ry` + 管半徑 | y 範圍 | 底板內？ |
|---|---|---|---|
| `teal` | `0.940` | `3.410…5.290` | ✓ |
| `g1` | `0.7975` | `3.553…5.148` | ✓ |
| `g2` | `0.5675` | `3.783…4.918` | ✓ |
| `g3` | `0.3475` | `4.003…4.698` | ✓ |

水平最寬是 `teal` 的 `4.320`，底板半寬 `4.70`，也在內。相機上緣在 local `5.19`（world 約 `5.02`）是 `y = 6.52`，最高點 `5.290` 遠低於它。

**建法**：Bézier 圓縮成橢圓路徑後設 `bevel_depth = 管半徑`，再轉 mesh。**不要**直接縮放 torus 物件 —— `scaleY = 0.214` 會把管徑一起壓成 `0.012`，變成一條看不見的細線。路徑 `48` 段、管剖面 `6` 邊。

### 7.5 模型不得重做、也不建的部件

`this.decor` 有 **18 個物件**（`CoinPusher.js:1572–1742` 的十一處 push，其中三處在迴圈裡）：headboard 的 frame／panel／badge／sill（4）、角柱（4）、外裙（2）、側玻璃（2）、neon bar（2）、`chuteFloor`（1）、`chuteWalls`（3）。

其中 **6 個保留可見**（§9.3 的例外集合），模型不做它們：

| 保留 | 世界位置 | 為什麼 |
|---|---|---|
| `glassPanes` ×2 | `\|x\| 4.125`，`y −0.25…2.15` | 透明度 `0.15`、`envMapIntensity 0.45` 已調好，模型重做只會更差 |
| `chuteFloor` ×1、`chuteWalls` ×3 | `z chuteZ()` 附近，`y −2.55…−1.30` | 完全在畫面外，而且它們以**絕對** `chuteZ()` 定位（`layoutGeometry` 的 `chuteParts`），正確追蹤床前緣。模型在 mount 內會被 Z 縮放拖開 —— 極值下錯開約 `1.2` |

**剩下 12 個由模型接手**，這是 §7.1–7.4 零件表的來源。

另有四件**不在** `decor` 裡，載入後本來就會留著，模型不得與它們重疊：

| 件 | 世界位置 | 為什麼留著 |
|---|---|---|
| `backPanel` | `z 4.285…4.535`，`y −0.25…2.35` | 帶 emissive 背景紋理的發光 backglass |
| `frontTrim` | `z lowerFrontZ −0.09…+0.05`，`y −0.08…0.04`，`\|x\| ≤ 4.075` | 出幣邊的金色唇線。它跨在模型前臉（`z_local −4.53` = `lowerFrontZ`）上，往前突出 `0.09`，讀起來就是前臉上的一條金唇 —— 這是想要的效果，不是衝突 |
| `chuteLip`、`chuteGlow` | `z −7.37` / `chuteZ()`，`y ≈ −2.2` | 完全在畫面外，無害 |
| 地板 `GridHelper` | `y −2.76` | 場景件，非機台件 |

### 7.6 預算

全部是 box / 橢圓盤 / 橢圓管，無貼圖。

| 群組 | 實際 tris |
|---|---|
| 四圈橢圓管（48 段 × 6 邊） | 2,304 |
| 其餘 26 件（box、導角） | 648 |
| **合計（30 個節點）** | **2,952** |

實測 **2,952 tris、111.2 KB**（現況 5,670 tris、1.16 MB）—— 面數少 48%、檔案小 91%。

四圈環佔 78% 的面數。要更小，`build_cabinet.py` 的 `RING_SPANS`（每個 Bezier span 的段數，現為 12，即 48 段）是第一個旋鈕。

## 8. 材質

四個材質，顏色全部取自 `config.js` 的 `PALETTE`。

| 材質 | 顏色 | 參數 |
|---|---|---|
| `shell_dark` | `shellDeep 0x081020` | roughness 0.18、metalness 0.85。拋光深色，吃 envMap 反射 |
| `trim_gold` | `gold 0xf2c94c` | roughness 0.26、metalness 0.92（＝現有 `BRASS`），emissive gold × 0.35 |
| `neon_teal` | `mint 0x00c8b4` | emissive mint，`KHR_materials_emissive_strength` 3.0 |
| `neon_gold` | `gold 0xf2c94c` | emissive gold，`KHR_materials_emissive_strength` 2.5 |

自發光走 `KHR_materials_emissive_strength`（three.js 原生支援），bloom（`setupBloom()`，強度 0.34 / 半徑 0.42 / 門檻 0.92）會接手。因此 `cabinetGlow` 那套「載入後 clone 材質再改 emissive」的邏輯整段刪掉。

## 9. 程式碼變更

### 9.1 新增 `tools/build_cabinet.py`

Blender bpy script。無輸入，輸出 `public/models/cabinet.glb`。

- 從 `src/game/config.js` regex 讀 `PALETTE` hex
- 用 §7 的零件表建幾何，節點名比照表中的名稱
- 建 §8 的四個材質
- 匯出 GLB，`+Y up`，不含貼圖

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/build_cabinet.py
```

Blender 版本：5.3.0 Alpha（本機已裝）。

### 9.2 `src/game/config.js`

刪除六個 key：`cabinetYaw`、`cabinetOffset`、`cabinetFitPart`、`cabinetWidthFit`、`cabinetHide`、`cabinetGlow`，連同它們的註解。

### 9.3 `src/game/CoinPusher.js`

`loadCabinet()` 從約 150 行降到約 30 行。刪掉 `labelOf` / `boxOf` / 縮放與對位、`cabinetHide` 迴圈、`cabinetGlow` 迴圈、整段 DEV raycast 診斷。

**必須保留的一段最小 traverse。** 場景從來沒有設 `scene.environment` —— `loadCoinEnvironment()`（`CoinPusher.js:298`）只把 PMREM 結果存進 `this.environmentTexture`，反射是逐材質指定的。所以把 traverse 全刪會讓 `shell_dark` 宣稱的拋光反射不存在，模型也不投射／不接收陰影：

```js
cabinet.traverse((object) => {
  if (!object.isMesh) return;
  object.castShadow = this.quality.shadows;
  object.receiveShadow = this.quality.shadows;
  for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
    if (!material || material.envMap || material.transparent) continue;
    material.envMap = this.environmentTexture;
    material.envMapIntensity = 0.55;
    material.needsUpdate = true;
  }
});
```

**不改用 `scene.environment`**（那會是一行）：現有程序化家具是逐件挑 envMap 與各自的 intensity 的（`addStaticBox` 的 options、`fitProp` 的 0.55），全域設定會一次改掉每一件的外觀。那是另一個題目。

保留 mount group（幾何面板要靠它拉伸 Z）與 `layoutGeometry()` 的重跑。

**decor 隱藏改為帶例外集合**（原 `CoinPusher.js:1079` 的 `for (const mesh of this.decor) mesh.visible = false`）：

```js
const keep = new Set([...this.glassPanes, ...this.chuteParts.map((part) => part.mesh)]);
for (const mesh of this.decor) if (!keep.has(mesh)) mesh.visible = false;
```

理由見 §7.5。物理側牆是獨立的 body，不受可見性影響。

**刪 `cabinetMetal()`，但保留它服務的那份清單。** 不再從模型抽材質 —— 外殼是我們自己授權的，材質數值已知，抽材質只是把舊 fit pass 的猜測搬回來。但那五個表面（`tray`、`trayTop`、`blade`、`scraper`、`rearDeckTop`）**仍然需要在外殼載入時被調整**，見 §13.1。`this.shellSurfaces` 就是原本的 `railParts`，換了一個說得出用途的名字。

### 9.4 `tests/geometry.test.js`

新增 §10 的測試。

## 10. 測試

一個 node test，解析 `public/models/cabinet.glb` 的 JSON chunk，取每個 mesh primitive 的 `POSITION` accessor `min`/`max`，套上節點階層的變換得到 local AABB。四組斷言：

**(a) 逐節點符合規格。** 每個節點的 AABB 落在 §7 零件表列出的範圍內（容差 `0.01`）。這是「模型有按規格建出來」—— 也是 marquee 那類數值必須在 spec 裡寫死的原因。順便抓漏件與多件：節點名集合必須與零件表完全一致。

**(b) A 類封包不相交。** 每個節點的 AABB 對 §6.1 的四個實體封包做相交測試。節點都是實心邊段，AABB 是緊的，不會誤判。

四圈橢圓管的 AABB 會把中間的洞算進去，屬於保守誤差 —— 它們在 local z `5.19`、`y 3.4…5.3`，離每一個 A 類封包都很遠，保守也不會誤判。

**(c) B 類飛幣弧線取樣。** 沿 §6.2 的參數式以 `t` 步進 `0.02`（51 點）取樣，每點再掃 `x ∈ [−3.45, 3.45]` 步進 `0.15`，斷言取樣點不落在任何節點的 AABB 內。

**(d) (b) 與 (c) 在四個幾何極值下重跑。** 用 `machineGeometryFor()` 算出 `{lowerCenterZ, lowerLength}` 的四個邊界組合（§5.3 的表），把 mount 變換 `z_world = lowerCenterZ + (lowerLength/9.06) × z_local` 套到節點 AABB 上再斷言。`dropZoneZ` 與 `scraperZ` 也從同一次 `machineGeometryFor()` 取，不寫死。

`build_cabinet.py` 本身不需要單元測試：它的輸出就是被上面這組斷言檢查的產物。

## 11. 明確排除的範圍

- **反射地板。** reference 的 glossy reflective floor 在場景裡不存在 —— 地板只是 `GridHelper`，`opacity 0.07`（`CoinPusher.js:971`）。「機台浮在光暈上」少了一半效果來源。本設計不處理，另案。
- **相機取景。** 不動。因此機台下半身與出幣區維持在畫面外；幾何仍然建完整，以免將來加開場運鏡或自由視角時要重做。
- **`scene.environment` 全域反射。** 見 §9.3，會一次改掉每一件程序化家具的外觀，另案。
- **兩處過時的程式註解。** §3.3 的 `config.js:28` 與 `config.js:249`。本設計只是不依賴它們，不順手改。
- **其他資產。** `coin.glb`、`stylized_jackpot_slot_machine.glb`、`low_poly_treasure_chest.glb` 都不動。（`supreme_money_gun.glb` 後來由 §16 取代並刪除。）slot machine 的重做是獨立的後續工作。
- **程序化家具。** `buildCabinetShell()`、`buildHeadboard()` 全部保留為 fallback。模型載不到時退回它們。

---

## 12. 第三版的修正（實作與試渲後）

第二版的規格建出來、用遊戲的相機參數在 Blender 裡渲過之後，有兩處只有看到才會發現的問題。兩者都不是尺寸算錯，是造型判斷錯。

| 問題 | 現象 | 修正 |
|---|---|---|
| marquee 底板是橢圓盤 | 橢圓抵在平頂背牆上只有 `x = 0` 一點接觸，marquee 懸在空中，縫隙往兩端張開到短半軸的整個 `1.05` | 改成矩形面板 `marquee_panel`，下緣就是背牆上緣，全寬貼合。同心環不動 —— 它是視覺主體，掛在什麼形狀上都一樣讀 |
| 基座發光環在內縮面上 | 完全看不見：`0.08` 高，埋在機身 `0.30` 的懸出後面，而這裡沒有任何東西會被它照亮 | 移到機身外表面 `\|x\| 4.84…4.86`，與上方兩條金線同一平面。後段（U 形的第三邊）刪掉 —— 相機永遠在正前方 |

另外三處實作細節，寫在這裡因為它們是規格層級的約束，不只是程式碼：

1. **Bezier 圓的 handle 必須先凍結成 `FREE` 再縮成橢圓。** Blender 的 bezier circle 帶 `AUTO` handle，而 `AUTO` 的意思是每次編輯都從控制點重算 —— 只縮 `co` 的話 handle 會被自動平滑規則重新推導，在這個長寬比下把短軸吹大 20%（實測 `ry 0.92` 變成 `1.124`）。凍結成 `FREE` 之後，同時縮放 `co` 與兩個 handle 就是圓的仿射映射，而 Bezier 曲線是仿射不變的，所以結果精確是橢圓。
2. **管剖面的量測基準。** `bevel_resolution = 1` 給六邊形剖面、平面朝 z，所以 z 向量到的是內切徑 `2r·cos(30°) = 0.866` 倍標稱值，不是 `2r`。測試因此用「佔標稱值的比例落在 `0.8…1.001`」而不是精確值 —— 這樣既擋得住壓扁（壓扁會掉到 `0.214`），也不綁死剖面邊數。
3. **glTF accessor 的 min/max 是 float32。** 授權的 `−4.53` 讀回來是 `−4.5300002`，所以「前緣不越過槍口」的斷言容差是 `1e-4`，不是 `0`。

第二版另外預估「檔案 60–90 KB」，實測 `111.2 KB`。差異來自四圈環的頂點數，見 §7.6。

---

## 13. 第四版的修正（在遊戲裡實跑後）

Blender 試渲（§12）看不到的東西：程序化幾何。試渲裡檯面、玻璃、推板、刮板都只是佔位塊，所以外殼與**真實機構表面**並排長什麼樣，只有在遊戲裡跑才看得見。跑了之後有三個問題。

### 13.1 機構表面必須在外殼載入時調整（第三版判斷錯誤）

第三版寫「自己授權的模型不需要 `cabinetMetal()`，rails 的程序化材質已經跟 PALETTE 一致」。**這句是錯的。**

那五個表面的材質是為**沒有外殼**的 fallback 調的，一直以來只要有機台模型就會被 `cabinetMetal()` 整個覆蓋掉。把覆蓋刪掉之後它們第一次真的出現在畫面上：

| 表面 | 自己的材質 | 露出來的樣子 |
|---|---|---|
| `scraper` | `PALETTE.metal` + `emissive: gold, emissiveIntensity: 0.35` | 一塊芥末黃平板站在檯面中後段，加上 bloom（門檻 0.92）是整台機器最亮的東西 |
| `tray` / `blade` | `PALETTE.shellRaised`，無 envMap | 平光塑膠 |
| `trayTop` / `rearDeckTop` | `PALETTE.glassTint`，無 envMap | 平光塑膠 |

`loadCabinet()` 原本那段的註解早就講過原因：「Nothing we can draw procedurally will sit next to a model without looking pasted on」。

**修正是兩項調整，不是換材質**：

```js
for (const mesh of this.shellSurfaces) {
  mesh.material.envMap = this.environmentTexture;
  mesh.material.envMapIntensity = 0.55;
  mesh.material.emissiveIntensity = 0;
  mesh.material.needsUpdate = true;
}
```

- **envMap**：這五個從來沒有過。外殼每一件都有（`loadCabinet` 的 traverse），所以少了它，這五個就是機器裡唯一不反射的東西 —— 這就是「pasted on」的全部內容。
- **emissive 關掉**：只有 `scraper` 有，`gold` 0.35。對著程序化家具它讀起來是一條發光護欄；對著近黑的外殼它是最亮的表面，讀起來是一塊漆過的板子。

**顏色刻意不動。** 中途試過把五個一起換成 `PALETTE.metal` 的深色金屬 —— 兩個抱怨都解決了，但層次感一起消失：外殼是 `shellDeep` 0x081020、機構表面 0x11202c，全部同一個明度，整台機器變成一片黑，第一層和下層分不出來。原本覆蓋上去的是下載模型的**銀色**金屬（Silver Skis 是銀色機台），所以才讀得出來；`PALETTE` 裡沒有對應的中明度金屬。`trayTop` 與 `rearDeckTop` 的 `glassTint` 跟檯面 deck 紋理是同一個色系，那份共用色調就是上下兩層的分界。

### 13.2 前窗上緣不能有燈條

`front_glow_top`（`y 2.16…2.20`，mint 自發光）刪掉。

相機下俯 26.57°，而開口上緣在**近處**（`z_local −4.53`），所以它投影到**畫面正中央**（實測螢幕縱向 −0.247，即中心下方 25%），讀起來是一條亮青色橫棒把機器切成兩半。

而且橫向的青色本來就不在背景圖的語言裡 —— 背景的橫線是細的金色，青色一律是垂直的。開口上緣由上方的暗色 bezel 定義就夠了。

**兩側的 `front_glow_L/R` 保留**：那兩條就是背景圖側牆的光柱，而且讀起來就是。

### 13.3 前窗上緣不能有任何橫樑（不只是燈條）

§13.2 只刪了燈條，但**結構橫樑 `front_bezel_top`（`y 2.20…2.60`）才是真正的遮擋物**。

相機在 `y = 5.4` 往下看，所以看檯面的視線通過前臉平面時是**高的**，不是低的 —— 這一點反直覺，也是它連續躲過兩輪的原因。實測：

| 看檯面 z | 視線在前臉平面的高度 |
|---|---|
| `−4.65`（推落邊緣） | `−0.06` |
| `−2.00` | `1.90` |
| **`−1.30`** | **`2.20`** ← bezel 下緣 |
| **`−0.14`** | **`2.60`** ← bezel 上緣 |
| `0` | `2.64` |
| `+4.36`（檯面最遠端） | `3.52` |

`front_bezel_top` 因此遮掉下層檯面 `z −1.30` 到 `−0.14` 這 1.16 寬的一整條 —— 正好是推落區中段。

**而且沒有任何高度能救它**：

| 要看到 | 開口上緣至少需要 |
|---|---|
| 檯面最遠端（`y 0, z 4.36`） | `y ≥ 3.52` |
| 刮板頂（`y 1.91, z 4.04`） | `y ≥ 4.15` |
| 背板頂（`y 2.35, z 4.41`） | `y ≥ 4.34` |

機身頂只有 `2.60`。所以**前窗必須向上敞開**，開口是 `y 0…2.60`，只由兩支立柱與下方面板框住。

這正是舊機台的做法：程序化機台前方只有 `frontTrim`（`y ≈ 0`），而下載模型的 `window_metal_frame` 是 `cabinetHide` 七項之一 —— §1 引用過那條註解，說它是「四支圍著窗口的立柱」。我加回了一根前人特意拿掉的橫樑。

兩側 `front_glow_L/R` 順勢延伸到 `y 0…2.60`，與立柱同高。

### 13.4 視線測試

這個失效模式連續兩輪靠眼睛才發現（`front_glow_top`、`front_bezel_top`），所以加了斷言：從相機位置對檯面與上層托盤取樣點連線，斷言沒有任何節點的 AABB 落在中間（slab 法，`t ∈ (0, 1)`）。取樣 `3` 個 x × `17` 個 z × `2` 個高度，在 §10 的十六個幾何極值下各跑一遍。

已驗證它抓得到：把 `front_bezel_top` 放回去，測試回報
`front_bezel_top blocks the view of (-3.6, 0.00, -0.35)`。

**這是唯一綁相機的斷言。** §6.3 原本主張取景邊界不做斷言，理由是相機一改斷言就失效。但同一個 bug 出現兩次之後，自動抓到的價值大於維護成本 —— 代價寫在測試註解裡：動 `setupScene` 的相機就要重推這組數字。

### 13.5 外殼在玩家視角的實際貢獻

實跑之後確認 §3 的推論：外殼大部分不在畫面裡。玩家真正看得到的是

- 前窗的暗色 bezel 與兩側青色光柱
- marquee 的同心環（部分被拉霸機遮住，如 §3.2 所料）
- 極少量的機身側面上緣

側牆的四對青色光柱與三條金線（`|x| 4.84…4.86`）在這個相機下**完全看不到** —— 它們在機身外表面，而相機在正中線上。它們的價值在未來的開場運鏡或自由視角，以及 §11 那個另案的反射地板。這是刻意的取捨（§4 選項「建完整外殼，細節只給可見處」），不是缺陷；但如果外殼要在當前視角有更多存在感，該投資的是前臉與 marquee，不是側面。

---

## 14. 第五版：把光挪到看得見的位置

第四版的評語是「太單調、很素」。這不是意外，是第一版取捨的直接後果：§7 把細節放在機身**外表面**（`|x| 4.84…4.86`），而相機在正中線上，那些面它一個都看不到。

### 14.1 先修一個量錯的結論

§13.5 說「該投資前臉與 marquee，不是側面」。**前半句是錯的。**

fov 是垂直的，而遊戲畫布接近正方（約 1.06），所以水平視野很窄，**前臉的外側被裁掉**。實測 `|x| = 4.55` 進入畫面的最前位置：

```
需要 0.637 × a ≥ 4.55，其中 a 是沿視軸的距離
→ z ≥ −3.62
```

| 位置 | 可見的 `\|x\|` 上限 |
|---|---|
| `z = −4.7`（前臉） | ≈ 2.8–3.6 ← 機身寬 4.85，兩側被裁 |
| `z = −2` | ≈ 5.4 ← 開始全寬可見 |
| `z = 4.36`（後方） | ≈ 8.8 |

所以真正全寬可見的是**中段到後方**。前臉只有靠中線的部分入鏡 —— 這也解釋了為什麼 `front_glow_L/R` 在畫面上只是邊緣兩抹微光。

### 14.2 光從外表面挪到內表面

| 動作 | 節點 |
|---|---|
| 刪 | `shell_light_teal_{1..4}_{L,R}`（8 支，在外表面，看不到） |
| 加 | `wall_rail_{L,R}` — `\|x\| 4.53…4.55`, `y 2.15…2.29`, 貫穿全長, `neon_gold_soft` |
| 加 | `wall_column_{1..4}_{L,R}` — `\|x\| 4.51…4.55`, `y 0.05…2.15`, `z_local {−2.5, −0.5, 1.5, 3.5}`, `neon_teal` |

- **光軌**是每側一條連續線，沿側牆上緣（玻璃頂之上）。兩條收束到消失點，就是背景圖的走廊，從走廊裡面看。
- **光柱**擺在 `z ≥ −2.5`，因為 §14.1 的裁切界線是 `−3.62`，擺更前面就跑出畫面。它們透過側玻璃（`\|x\| 4.0…4.25`、透明度 0.15）被看到，隔 0.26 —— 那點深度是刻意的。

外表面的三條金線（`trim_gold_rail_*`）保留：它們定義機身外緣的輪廓，在 3/4 視角有用，而且只花 48 tris。

### 14.3 第五個材質：`neon_gold_soft`（strength 1.4）

光軌一開始用 `neon_gold`（strength 2.5，跟 marquee 同心環同一個），斷面 `0.30` 高。實跑是一條粗白帶：**強度必須隨發光面積下降**。每側光軌長 9.75、在透視裡佔畫面高度一大段，用環的強度會整條越過 bloom 門檻（0.92）。

改成 strength `1.4`、斷面 `0.14` 高。背景圖的橫線是細的金色，不是熔的。

### 14.4 marquee 環從四圈變六圈（同預算）

`RING_SPANS` 從 12 降到 8（每圈 48 段 → 32 段），省下的面數換兩圈環。六圈 `rx = 4.30 / 3.74 / 3.18 / 2.62 / 2.06 / 1.50`，`ry/rx = 0.214` 不變。

密一點更接近背景圖天花板那組往深處遞減的環，而且給 §14.5 的追光更多級可以走。面數 2,304 → 2,304，零成本。

### 14.5 動態

模型的 emissive 原本完全靜態，而 `animate()` 早就有 `this.neon` 的脈動迴圈（只是那些件現在都被隱藏了）。

`loadCabinet()` 收集 `marquee_ring_*` 與 `wall_column_*`，**每個 mesh 複製一份材質**（glTF 一個材質共用給所有使用它的 mesh —— 不複製的話整組會同步閃，這正是舊 `cabinetGlow` 註解記錄過的陷阱），並從幾何自身的 bounding box 取一個相位：

- 環：相位取自半徑 → 追光由內往外穿過 marquee
- 光柱：相位取自 z 中心 → 呼吸沿走廊往深處跑

```js
const wave = 0.5 + 0.5 * Math.sin(this.elapsed * 2.4 - part.phase);
part.material.emissiveIntensity = part.base * (0.2 + 0.8 * wave * wave);
```

平方是為了讓波峰窄：純 sine 讀起來是「全部一起呼吸」，平方之後讀起來是「一道亮帶在跑」。整段在既有的 `reducedMotion` 保護內。

### 14.6 現況

32 個節點、2,920 tris。相較第四版多了 4 個節點、24 個三角面 —— 視覺變化的成本幾乎全在**位置**，不在幾何量。

---

## 15. 第六版：檯面藝術，與前方上空的否決

### 15.1 檯面是畫面上最大的單一表面

相機直視檯面縱深，所以 `createDeckTexture()` 畫出來的東西承載了機器大部分的外觀，而它原本只有：深藍漸層、一個淡金六角浮水印、兩條跑道線加青綠刻度。

改成（`CoinPusher.js` 的 `createDeckTexture()`，與 Blender 無關）：

- **金色網格**，每一個世界單位一條、每第四條加亮。這是背景圖那句 `glossy reflective floor with faint gold grid lines` 唯一能被直接引用的地方。
- **推落邊發光帶**：前緣一道青綠漸層，往後淡出一個半硬幣直徑。推落邊是檯面上唯一會給分的線，而在此之前檯面本身完全沒有說明這件事 —— 金色前緣飾條是從玻璃外面標記它的，而低頭看檯面的玩家不會看到那裡。
- 跑道線與刻度保留但調暗（0.26 → 0.20 / 0.30 → 0.26）：網格接手了結構，兩套全強度的系統會互打。
- 解析度 512 → 1024（`lowPower` 仍為 512），並套上最大 anisotropy —— 網格在深度方向被壓縮得很厲害。

### 15.2 貼圖方向是推導出來的，不是試出來的

舊註解寫「前後對稱是刻意的：box 面的 V 方向從這裡看不出來，有上下之分的設計會有一半機率上下顛倒」。實際上推得出來：

```
BoxGeometry 的 +Y 面 = buildPlane('x', 'z', 'y', 1, 1, ...)
uv.v = 1 − iy/gridY，而 iy = 0 落在 z = −depth/2
  → uv.v = 1 是機台前緣
CanvasTexture 預設 flipY，uv.v = 1 取樣影像第一列
  → canvas y = 0 是推落邊，canvas y = height 是背板
```

已在畫面上驗證：發光帶出現在前緣。搞反的話，那道帶子會去標記硬幣永遠到不了的後牆。

**網格會隨檯面拉伸，這是可接受的。** `placeBox` 縮放 mesh 而不重建幾何，也沒有任何地方會重新產生這張貼圖，所以在幾何面板最長的檯面上格子會變成 1 × 1.43 —— 跟六角浮水印和跑道線一直以來承受的是同一個拉伸。而且往深處看時 z 被壓縮得很厲害，拉伸過的格子在螢幕上反而比真正的正方形更接近正方。

### 15.3 前方上空：量完決定不做

`y 3.8…5.6`、機台前緣上方那塊空間看起來很誘人，但畫布接近正方（§14.1）把它殺掉了：

| 量測 | 螢幕橫向位置 |
|---|---|
| 拉霸機邊緣（`\|x\| 1.12, z −4`） | `±0.351` |
| 拱門腳 `\|x\| = 1.6`（`z −4.7`） | `0.545` |
| 拱門腳 `\|x\| = 3.6` | `1.23` —— 已裁出畫面 |

中央必須留給拉霸機（`\|x\| > 1.6`），而外側 `\|x\| > 3.6` 出畫面，所以能看見的只剩 `0.545…1.0` 兩段 —— 中間 `0.351…0.545` 是空的。成品會是「拉霸機、空隙、左右上角各一根發光短棒」，正是 `buildMachine` 為 neon bar 寫過的那句「two loose glowing sticks rather than part of the machine」。

**沒有做。** 這是本設計第四個因為量測而被否決或移除的元件（`front_glow_top`、`front_bezel_top`、`plinth_glow_back`，加上這個），全部同一個成因：這個相機能看到的體積比剖面圖看起來窄得多。

### 15.4 順帶量到的：背板幾乎被刮板擋住

背板（`z 4.285…4.535`）整體佔螢幕 `x ±0.466`、`y 0.126…0.418`，而拉霸機在 `y ≥ 0.529`，兩者**不重疊** —— 所以它一度看起來是塊乾淨的畫布。但刮板（`y 0.71…1.91`, `z 4.04`）擋在前面：解出來背板只有 `y > 1.814` 的部分露出刮板上緣，約全高的 21%。

`createBackTexture()` 的 `PUSH YOUR LUCK` 畫在 canvas 底部，落在被擋住的那一段裡 —— 畫面上看不到。未動，記錄於此。

---

## 16. 第七版：發射器

`supreme_money_gun.glb`（Sketchfab，17,744 tris、1.59 MB）換成 `launcher.glb`（**548 tris、約 45 KB**）。面數少 97%、檔案小 97%。

### 16.1 它有九成在畫面外

先量，因為這決定了要做多少：

| 點 | 螢幕 y |
|---|---|
| 槍尾 `z −6.82` | `−1.284` ← 出畫面 |
| 掛點 `y −0.25` | `−1.026` ← 出畫面 |
| 槍口 `y 0.06` | `−0.968` ← 貼著下緣 |
| `y 1.10`（新的鰭頂） | `−0.75` |

`z = −5.9` 處畫面下緣落在 `y = −0.107`。所以整支發射器只有那條線以上的部分存在於畫面裡，而上限是 `y ≈ 1.40`（再高就開始吃到最長設定下的檯面前緣）。**整個設計活在 1.2 個單位的帶子裡。**

### 16.2 發光面必須朝向相機

相機到發射器的方向是 `(0, −4.9, 3.5)`，所以各法線方向的投影面積是：

| 面 | 法線 | 與視線的餘弦 |
|---|---|---|
| 頂面 | `+y` | **0.81** |
| 後面 | `−z` | **0.58** |
| 側面 | `±x` | **≈ 0**（發射器在中線上） |

第一版把鰭的發光放在**外側面**、槍口環朝 `+z`（背對相機）—— 兩個都在投影面積最小的方向，所以整支讀起來只是一團暗糊。改成：鰭頂發光帽（頂面）、尾板發光片（後面）、加寬脊線（頂面）。

另外一個實作錯誤：`launcher_core` 原本從 `y 0.30` 起，而 `launcher_breech` 到 `y 0.58` —— 核心下面三分之二被包在機匣裡面，只有 0.4 露出來。移到機匣上方。

### 16.3 質量必須放在可見帶裡，不只是發光

第一版把機身質量放在 `y ≤ 0.58`（機匣）與 `y ≤ 0.16`（底盤）—— 那兩段幾乎全在畫面下緣 `−0.107` 以下。留在可見帶裡的只有鰭，而鰭是 `0.06` 厚的薄片，從中線上的相機看是**側面朝向、投影面積趨近零**。

結果就是畫面上只有兩條發光帽浮在什麼都沒有的上面 —— 這正是「上面的光太亮，看不出發射器長怎麼樣」的成因。亮度只是次因；就算調暗，本體也還是沒有東西可看。

修正是把質量搬進帶子裡：機匣升到 `y 0.16…0.95`，它的**後臉**（`0.60 × 0.79`，餘弦 0.58）成為玩家真正在看的面。發光跟著搬到後臉：中央金色核心、兩側青色排氣槽。鰭移到機匣前方沿槍管排列，讓輪廓往槍口逐段下降，頂緣只留一條 `0.03` 的細線。

### 16.4 造型

機身在平面上是**收窄的箭形**（`tapered_box`）。相機是俯視，而平面輪廓是唯一能說明「這東西朝哪裡」的線索 —— 純方塊什麼都沒說，而槍管在這個距離太短讀不出來。

配色沿用機台的分工：**縱向的脊線是金色，直立的鰭是青色**，跟外殼「橫金縱青」一致。

| 節點 | local z | y | x |
|---|---|---|---|
| `launcher_chassis` | `−0.92…0.62` | `−0.25…0.16` | 後 `±0.40` → 前 `±0.17`（收窄） |
| `launcher_channel` | `−0.80…0.66` | `0.16…0.20` | 後 `±0.14` → 前 `±0.07`，`neon_gold_soft` |
| `launcher_breech` | `−0.92…−0.34` | `0.16…0.95` | `≤0.30` |
| `launcher_core` | `−0.96…−0.92` | `0.34…0.80` | `≤0.11`，`neon_gold_soft` |
| `launcher_vent_{L,R}` | `−0.95…−0.92` | `0.28…0.86` | `0.19…0.26`，`neon_teal_soft` |
| `launcher_fin_{L,R}` | `−0.34…0.20` | `0.16…1.05` | `0.24…0.30` |
| `launcher_fin_glow_{L,R}` | `−0.34…0.20` | `1.05…1.08` | `0.24…0.30`，`neon_teal_soft` |
| `launcher_barrel` | `0.20…0.66` | `−0.06…0.18` | `≤0.13` |
| `launcher_muzzle` | `0.64…0.70` | 環，`r 0.125`、管 `0.028` | `neon_teal_soft` |

### 16.5 全部用弱化材質，機身用 `shell_raised`

發射器是畫面裡**離相機最近**的物件：視軸距約 `5.5`，機台中段約 `12`，所以同一條發光帶在這裡覆蓋約 `(12/5.5)² ≈ 5` 倍的螢幕面積。用機台的強度會直接蓋過自己的本體。

因此 lib 多了 `neon_teal_soft`（strength 1.2），發射器的金色一律用既有的 `neon_gold_soft`（1.4）。

機身則反過來：`shell_dark`（`0x081020`）在機台上行得通，因為背後有打亮的 hall 把輪廓襯出來；發射器懸在空的前景裡，近黑沒有任何邊緣可讀。改用 `shell_raised`（`PALETTE.shellRaised 0x142235`），也就是程序化機台給抬起件用的那個色階。

### 16.4 兩個承重的平面

座標是**發射器群組的區域座標**，群組在 `(launcherX, 0, GAME.launcherZ)`。所以區域 y 就是世界 y，區域 z 加 `launcherZ` 是世界 z。兩個數字不是美感問題：

- `max local z = 0.70` = `launcherMuzzleZ − launcherZ`。硬幣就是在那個平面被釋放的，短了會憑空出現在槍口前，長了會生成在模型內部。
- `min local y = −0.25` = `launcherMountY`。

`buildLauncher()` 因此**完全不做 fit** —— 沒有旋轉、沒有縮放、沒有重新定位，只剩打光。`launcherModelLength`（`1.62`）隨之從 config 刪除：它唯一的用途是舊的縮放。`tests/launcher.test.js` 把模型釘在上面兩個平面上。

### 16.6 蓄力沒有接

`rules.js` 有 `chargeToPower()` 與 `launchSpeedFor()`，但 `src/` 裡**沒有任何地方呼叫它們** —— 蓄力機制只存在於規則與測試裡，還沒接進遊戲。所以「核心亮度反映蓄力」得先接那條線，那是功能不是重做，未做。

核心改成掛在外殼那條 neon 動畫清單上做緩慢呼吸。只有核心：這是貼著畫面下緣的前景物件，整支點亮只會把視線從檯面拉到一條縫上。

### 16.7 工具重整

`build_cabinet.py` 與 `build_launcher.py` 共用 `tools/blender_lib.py`（palette 讀取、sRGB 轉換、材質集、`box` / `mirrored` / `tapered_box`、匯出）。材質集移進 lib 是為了保證兩個模型用的是**同一組五個材質**，而不是各自宣告一份會漂移的副本。

測試端同理：`tests/glb.js` 提供 GLB 讀取與逐節點 AABB，`cabinet.test.js` 與 `launcher.test.js` 共用。

### 16.8 舊資產已刪，出處補齊

`public/models/supreme_money_gun.glb`（1.59 MB）已刪除。它未被 git 追蹤，所以無法從版本庫復原；來源是
`https://sketchfab.com/3d-models/supreme-money-gun-d25671a84cd846b28fb5dc3c18408b57`（MacDrawz、CC BY 4.0），需要時重新下載。

`index.html` 的 `.asset-credit` 區塊原本**只掛著這一筆**。直接整塊刪掉會讓專案變成「出貨兩個 CC BY 資產、零出處」，因為另外兩個下載模型的 glTF `asset.extras` 明確寫著授權：

| 檔案 | 作者 | 授權 |
|---|---|---|
| `low_poly_treasure_chest.glb` | cattleya | CC-BY-4.0 |
| `stylized_jackpot_slot_machine.glb` | Burak Özcan | CC-BY-4.0 |

所以區塊改成標示這兩筆，並註明「已調整比例」（`fitProp()` 會縮放它們，CC BY 要求標示是否有修改）。`coin.glb` 是自製（Blender I/O），`cabinet.glb` 與 `launcher.glb` 是本設計產出，都不需要出處。

---

## 17. 第八版：硬幣配色

一般幣金色、高分幣綠色，難分辨，而且整個畫面已經太多青綠。

### 17.1 為什麼舊配色一定糊

高分幣是在**同一張金色貼圖上做顏色相乘**（`color = PALETTE.mintSoft`）。three.js 的 `color` 是乘上 `map` 的，所以染色**只能減、不能加**通道。金色的藍通道本來就低，任何冷色乘上去都不會變冷，只會變濁 —— 得到的是橄欖綠。

結果是兩種幣「同一個明度上的一次濁色相偏移」，而且那個色相正是場景裡到處都是的青綠。這不是選錯顏色，是這條路本身做不出對比。

### 17.2 銀與金，出自同一張金色資產

`coin.glb` 的材質是分開的三張貼圖：`normalTexture`（浮雕）、packed AO/Roughness/Metallic、`baseColorTexture`（金色）。所以可以**只丟掉 baseColor**，把色相完全交給 `color`，而浮雕與材質反應原封不動。

| | 舊 | 新 |
|---|---|---|
| 一般幣 | 貼圖原色（金） | `map = null`，`color` = `PALETTE.white × 0.62`，metalness 0.92、roughness 0.56、envMapIntensity 0.55 |
| 高分幣 | 金貼圖 × `mintSoft`（濁綠） | 貼圖原色不動，加 `emissive = gold`、強度 0.18 |

兩者現在在**色相與明度兩軸**上都拉開，而不是同一張金貼圖上的染色差。

**方向不是隨便挑的**：機制本來就叫鍍金。`gildCoins()` 把一般幣變成高分幣，而「銀幣變成金幣」正是玩家該看到的那件事。同時也不引入第三個色相，維持場景的青金二色紀律。

### 17.3 一次過亮的中間版本

金屬的顏色**完全來自它反射的東西**，所以三個參數都在調亮度，各做不同的事：`color` 染反射、`envMapIntensity` 縮放餵給它的 HDR、`roughness` 把主光的高光從一個熱點攤成一片光澤。

調了兩輪：

| 版本 | color | metalness | roughness | envMapIntensity | 結果 |
|---|---|---|---|---|---|
| 一 | 純白 | 1.00 | 0.34 | 1.1 | 鏡面鉻。頂面把 `decor_shop_1k.hdr` 那個明亮室內整個反射成白塊，比霓虹還亮，而且平到看不出 normal map 的浮雕 |
| 二 | white × 0.74 | 0.95 | 0.44 | 0.8 | 仍然偏亮 |
| **三** | **white × 0.62** | **0.92** | **0.56** | **0.55** | 暗拉絲金屬，高光收成光澤 |

`PALETTE` 裡沒有銀色，所以色相是它的 white 降低明度，而不是新增一個色相。

### 17.4 粒子跟著換

`emitParticles()` 原本高分幣噴 `mintSoft`、一般幣噴 `goldSoft`（註解寫明「mint 配合綠色高分幣，讓硬幣與它的獎勵讀成同一件事」）。現在反過來：高分幣噴 `goldSoft`、一般幣噴 `white`。

---

## 附錄 A：背景圖生成 prompt

```
A wide symmetric interior of a futuristic neon casino hall, cyberpunk,
viewed straight down the central axis with a single vanishing point in
the middle. Teal and gold neon strip lighting, dark navy-black
architecture, glossy reflective floor with faint gold grid lines,
vertical light columns along both side walls, concentric glowing rings
in the ceiling, a few potted plants and low round gaming tables at the
sides. Deep atmospheric haze in the distance. No people, no text, no
logos, no UI. Cinematic, dark, high contrast.
Aspect ratio 21:9, 2560x1097.
```
