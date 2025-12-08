<p align="center">
  <a href="https://github.com/Xcheng-dada/Majsoul-Plugin/"><img src="https://wx2.sinaimg.cn/mw690/006wqMDrly1i80d2ugs6sj30u00u00wd.jpg" width="256" height="256" alt="Majsoul-Plugin"></a>
</p>
<h1 align = "center">Majsoul-Plugin</h1>
<h4 align = "center">✨ 基于<a href="https://github.com/TimeRainStarSky/Yunzai" target="_blank">TRSS-Yunzai</a>的雀魂麻将多功能插件✨ </h4>
<div align = "center">
        <a href="https://github.com/Xcheng-dada/Majsoul_Plugin/wiki" target="_blank">说明文档</a> &nbsp; · &nbsp;
        <a href="https://github.com/Xcheng-dada/Majsoul_Plugin/wiki#%E4%B8%A8%E6%8C%87%E4%BB%A4%E5%88%97%E8%A1%A8" target="_blank">指令列表</a> &nbsp; · &nbsp;
        <a href="https://github.com/Xcheng-dada/Majsoul_Plugin/wiki#%E4%B8%A8%E5%B8%B8%E8%A7%81%E9%97%AE%E9%A2%98-qa">常见问题</a>
</div>
<h4 align = "center"></h4>
<div align="center">
  <a href="https://nodejs.org/">
    <img src="https://img.shields.io/badge/node.js-18%2B-green?logo=node.js&logoColor=white" alt="Node.js">
  </a>
  <a href="https://github.com/TimeRainStarSky/TRSS_Yunzai">
    <img src="https://img.shields.io/badge/TRSS--Yunzai-Plugin-success" alt="TRSS-Yunzai">
  </a>
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL--3.0-blueviolet" alt="LICENSE">
  </a>
</div>

## **丨前言&插件简介**
一个雀魂麻将多功能插件，插件不包括TRSS-Yunzai，应该配合[**TRSS-Yunzai**](https://github.com/TimeRainStarSky/Yunzai)使用：

项目地址：https://github.com/Xcheng-dada/Majsoul-Plugin

> [!TIP]
> 本插件部分功能基于 [Majsoul_bot](https://github.com/DaiShengSheng/Majsoul_bot/) 移植至TRSS-Yunzai

## 丨安装方法
1.  在TRSS-Yunzai目录下使用以下命令拉取本项目
    ```
    git clone https://github.com/Xcheng-dada/Majsoul-Plugin.git ./plugins/Majsoul-Plugin
    ```
2.  然后使用如下命令安装依赖
    ```
    cd ./plugins/Majsoul-Plugin
    pnpm install
    ```
3.  重启 TRSS-Yunzai，进入机器人在的群聊，即可正常使用本插件。

## 丨已实现的功能
### 丨雀魂抽卡模块 (功能完整)
*   **十连抽卡**：模拟雀魂抽卡，自动合成并发送十连结果图片。
*   **多卡池系统**：支持多个联动UP卡池（如辉夜、天麻、斗牌传说等），可随时切换。
*   **每日限制**：每个用户每日默认可进行 **15** 次十连抽卡。
*   **群组独立配置**：每个QQ群可以独立设置和切换卡池，互不影响。
*   **管理员工具**：管理员可为特定用户**设定**抽卡机会、**查询**状态、**重置**抽卡次数。

### 丨雀魂用户管理模块 (功能完整)
*   **玩家搜索**：通过雀魂牌谱屋API搜索玩家信息（昵称、ID、段位）。
*   **UID绑定**：将雀魂玩家UID与QQ号绑定，便于后续查询。
*   **多账号管理**：支持绑定多个雀魂UID，并可设置主账号。
*   **绑定切换**：可随时切换已绑定的主账号。
*   **账号解绑**：支持解绑指定UID或全部解绑。

## 丨使用指令
### 所有用户可用
| 指令 | 说明 | 示例 |
| :--- | :--- | :--- |
| `#雀魂十连` | 进行十连抽卡。 | `#雀魂十连` |
| `#切换雀魂卡池 [卡池名]` | 切换本群的抽卡卡池。 | `#切换雀魂卡池 辉夜up池` |
| `#查看雀魂卡池` | 查看本群当前使用的卡池。 | `#查看雀魂卡池` |
| `#查询抽卡次数 [QQ号]` | 查询自己或他人的今日抽卡情况。 | `#查询抽卡次数 123456` |
| `#雀魂搜索 [玩家名]` | 搜索雀魂玩家信息（昵称、ID、段位）。 | `#雀魂搜索 宫永咲` |
| `#雀魂绑定 [UID]` | 绑定雀魂玩家UID（6-10位数字）。 | `#雀魂绑定 12345678` |
| `#雀魂切换 [UID]` | 切换已绑定的主账号。 | `#雀魂切换 12345678` |
| `#雀魂解绑` | 解绑所有已绑定的雀魂UID。 | `#雀魂解绑` |
| `#雀魂解绑 [UID]` | 解绑指定的雀魂UID。 | `#雀魂解绑 12345678` |
| `#雀魂我的绑定` | 查看自己绑定的所有雀魂UID。 | `#雀魂我的绑定` |

### 管理员专用 (`permission: 'master'`)
| 指令 | 说明 | 示例 |
| :--- | :--- | :--- |
| `#设置用户次数 [QQ号] [次数]` | 设置指定用户的抽卡次数。 | `#设置用户次数 123456 5` |
| `#重置用户次数 [QQ号]` | 重置**指定用户**的今日抽卡记录。 | `#重置用户次数 123456` |

### 支持的卡池
-   当前up池
-   辉夜up池
-   天麻up池1
-   天麻up池2
-   标配池
-   斗牌传说up池
-   狂赌up池

## 丨段位系统说明
插件使用完整的雀魂段位系统，支持以下段位计算：

### 段位等级
1.  **初心** (Level 1)
2.  **雀士** (Level 2) - 分为一、二、三
3.  **雀杰** (Level 3) - 分为一、二、三
4.  **雀豪** (Level 4) - 分为一、二、三
5.  **雀圣** (Level 5) - 分为一、二、三
6.  **魂天** (Level 6) - 分为1-20星

### 段位分数
- 每个段位有对应的分数上限
- 魂天段位每100分转换为1.0星
- 达到段位上限后自动升段

## 丨常见问题 Q&A
### 丨抽卡时提示"插件加载错误"或类似错误？
1.  **确保依赖已安装**：在插件目录 (`plugins/Majsoul-Plugin/`) 内执行 `pnpm install`。
2.  **检查Node.js版本**：确保版本为 **18** 或以上。
3.  **重启Yunzai**：修改配置或安装依赖后，请重启机器人。
4.  **查看详细日志**：错误信息通常会在控制台输出，根据日志排查问题。

### 丨管理员指令没有反应？
请确认发送指令的QQ号已在TRSS-Yunzai的 `config.yaml`（或类似配置）中设置为**管理员 (master)**。

### 丨搜索玩家时提示"暂未搜索到该玩家ID"？
1.  **玩家需有金之间对局**：雀魂牌谱屋API仅收录在金之间有对局记录的玩家。
2.  **检查昵称是否正确**：请确保输入完整的玩家昵称。
3.  **尝试英文名搜索**：部分玩家可能使用英文名或特殊字符。

### 丨绑定UID时提示"UID格式不正确"？
- 雀魂UID为6-10位数字，请检查输入是否正确。
- 确保输入的是纯数字UID，不包含其他字符。

### 丨切换UID时提示"尚未绑定该UID"？
请先使用`#雀魂我的绑定`查看已绑定的UID列表，然后使用列表中的UID进行切换。

## 丨未来计划
-   [ ] 玩家详细数据查询（基于已绑定的UID）
-   [ ] 对局记录详细分析
-   [ ] 牌谱链接生成与分享
-   [ ] 对局信息订阅与播报
-   [ ] 牌理功能

## | 感谢
-   [DaiShengSheng / Majsoul_bot](https://github.com/DaiShengSheng/Majsoul_bot/) ：原Python版本雀魂插件，抽卡功能移植自该项目。
-   [SAPikachu / amae-koromo](https://github.com/SAPikachu/amae-koromo) ：雀魂牌谱屋项目，提供玩家数据查询API。