# App Store Connect 填寫草稿

## 基本資料

- 名稱：金幣夜曲：3D推幣機（英文：Coin Nocturne: 3D Coin Pusher）
- 副標題：釘板・寶箱拉霸・連擊金幣雨
- Bundle ID：io.github.toikusen.nocturne
- 主畫面顯示名稱：金幣夜曲
- 類別：遊戲 > 休閒遊戲
- 內容版權：含第三方內容且有權利（Pixabay 音效、Cinzel 字型；Tripo 模型需付費重新生成）
- 供應地區：174 個，排除中國大陸（遊戲需版號）
- 主要語言：繁體中文
- 隱私權政策網址：https://github.com/toikusen/coin-pusher/blob/main/PRIVACY.md
- 價格：免費，無 App 內購買

## 描述

投下金幣，看它穿越釘板、撞上彈跳器，落在推台上被推板一路推向邊緣。
趁推板後退時堆疊硬幣，觸發連續推落拿高分；推出寶箱還能轉拉霸，抽中硬幣雨、地震或鍍金大獎。

・即時 3D 物理，每一枚硬幣都真實碰撞、堆疊、滑落
・一關接一關的任務，每天完成 3 關再送加碼獎勵
・寶箱拉霸：777、硬幣雨、地震、鍍金四種大獎
・自動投幣，放著也能看機台運轉；按住投幣鍵可以連續投
・無廣告、無內購、離線可玩

遊戲中的硬幣不具任何現實價值，無法購買、兌換或提領。

宣傳文字：無廣告、無內購，離線也能玩的 3D 推幣機。一關接一關的任務，每天還有加碼獎勵。

## 關鍵字（100 字元內，逗號分隔）

推幣,硬幣,金幣,街機,休閒,物理,拉霸,寶箱,coin pusher,arcade,nocturne

## App 隱私

- 資料蒐集：不蒐集資料（Data Not Collected）

## 年齡分級問卷

- 模擬賭博（Simulated Gambling）：頻繁（推幣機本身加上約每 30 秒一次的寶箱拉霸）→ 計算結果 18+
- 真錢賭博、競賽：無
- 其他（暴力、性、藥物等）：皆無
- 使用者產生內容、無限制網路存取：無

## 出口合規

Info.plist 已宣告 `ITSAppUsesNonExemptEncryption = NO`，上傳時不會再詢問。

## 截圖（必填尺寸）

- 配備動態島的 iPhone（中型顯示器）：1206 × 2622（iPhone 18 Pro / iPhone 17 模擬器）
- iPad 13 吋：2064 × 2752（iPad Pro 13-inch 模擬器）

重拍方式：Debug 版會在啟動 6 秒後執行 `COIN_PUSHER_EVAL` 裡的腳本，用它按開始並開啟自動投幣，等幾分鐘再截圖。

```sh
JS="setInterval(()=>{const d=document.getElementById('onboarding');if(d&&d.open){document.getElementById('startButton').click();return;}const a=document.getElementById('autoButton');if(a&&!a.disabled&&a.getAttribute('aria-pressed')!=='true')a.click();},1500);"
SIMCTL_CHILD_COIN_PUSHER_EVAL="$JS" xcrun simctl launch <udid> io.github.toikusen.nocturne
xcrun simctl io <udid> screenshot shot.png
```
