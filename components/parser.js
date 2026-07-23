import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'data.json'), 'utf8'))

const JPNAME = 0, RONAME = 1, ENNAME = 2
const DAISANGEN = 37, DAISUUSHI = 50, TSUMOGIRI = 60

const RUNES = {
  east: ["東", "East ", "East "],
  south: ["南", "South ", "South "],
  west: ["西", "West ", "West "],
  north: ["北", "North ", "North "],
  bakaze: ["場風", "? ", "? "],
  jikaze: ["自風", "? ", "? "],
  dabururiichi: ["両立直", "Double Riichi ", "Double Riichi "],
  mangan: ["満貫", "Mangan ", "Mangan "],
  haneman: ["跳満", "Haneman ", "Haneman "],
  baiman: ["倍満", "Baiman ", "Baiman "],
  sanbaiman: ["三倍満", "Sanbaiman ", "Sanbaiman "],
  yakuman: ["役満", "Yakuman ", "Yakuman "],
  kazoeyakuman: ["数え役満", "Kazoe Yakuman ", "Counted Yakuman "],
  kiriagemangan: ["切り上げ満貫", "Kiriage Mangan ", "Rounded Mangan "],
  agari: ["和了", "Agari", "Agari"],
  ryuukyoku: ["流局", "Ryuukyoku", "Exhaustive Draw"],
  nagashimangan: ["流し満貫", "Nagashi Mangan", "Mangan at Draw"],
  suukaikan: ["四開槓", "Suukaikan", "Four Kan Abortion"],
  sanchahou: ["三家和", "Sanchahou", "Three Ron Abortion"],
  kyuushukyuuhai: ["九種九牌", "Kyuushu Kyuuhai", "Nine Terminal Abortion"],
  suufonrenda: ["四風連打", "Suufon Renda", "Four Wind Abortion"],
  suuchariichi: ["四家立直", "Suucha Riichi", "Four Riichi Abortion"],
  fu: ["符", "符", "Fu"],
  han: ["飜", "飜", "Han"],
  points: ["点", "点", "Points"],
  all: ["∀", "∀", "∀"],
  pao: ["包", "pao", "Responsibility"],
  tonpuu: ["東喰", " East", " East"],
  hanchan: ["南喰", " South", " South"],
  friendly: ["友人戦", "Friendly", "Friendly"],
  tournament: ["大会戦", "Tounament", "Tournament"],
  sanma: ["三", "3-Player ", "3-Player "],
  red: ["赤", " Red", " Red Fives"],
  nored: ["", " Aka Nashi", " No Red Fives"],
}

const YSCORE = [
  [0, 16000, 48000],
  [16000, 8000, 32000],
]

function padList(arr, expectedLen, fillObj) {
  let res = [...arr]
  while (res.length < expectedLen) res.push(fillObj)
  return res
}

function relativeSeating(a, b) {
  return (a - b + 3) % 4
}

const TileType = { M: 0, P: 1, S: 2, Z: 3 }

class Tile {
  constructor(num, type) {
    this.num = num
    this.type = type
  }
  encodeTenhou() {
    if (this.num !== 0) return 10 * (this.type + 1) + this.num
    return 50 + (this.type + 1)
  }
  static parse(text) {
    return new Tile(parseInt(text[0]), TileType[text[1].toUpperCase()])
  }
  isAka() { return this.num === 0 && this.type !== TileType.Z }
  deaka() {
    if (this.type !== TileType.Z && this.num === 0) return new Tile(5, this.type)
    return this
  }
  equals(other) {
    return this.num === other.num && this.type === other.type
  }
}

class DiscardSymbol {
  constructor(tile, tsumogiri = false, riichiDeclaration = false) {
    this.tile = tile
    this.tsumogiri = tsumogiri
    this.riichiDeclaration = riichiDeclaration
  }
  encodeTenhou() {
    let res = this.tsumogiri ? TSUMOGIRI : this.tile.encodeTenhou()
    if (this.riichiDeclaration) res = `r${res}`
    return res
  }
}

class ChiSymbol {
  constructor(a, b, tile) {
    this.a = a; this.b = b; this.tile = tile
  }
  encodeTenhou() {
    return `c${this.tile.encodeTenhou()}${this.a.encodeTenhou()}${this.b.encodeTenhou()}`
  }
}

class PonSymbol {
  constructor(a, b, tile, feederRelative) {
    this.a = a; this.b = b; this.tile = tile; this.feederRelative = feederRelative
  }
  encodeTenhou() {
    let t = [this.a.encodeTenhou().toString(), this.b.encodeTenhou().toString()]
    t.splice(this.feederRelative, 0, `p${this.tile.encodeTenhou()}`)
    return t.join('')
  }
}

class DaiminkanSymbol {
  constructor(a, b, c, tile, feederRelative) {
    this.a = a; this.b = b; this.c = c; this.tile = tile; this.feederRelative = feederRelative
  }
  encodeTenhou() {
    let pos = this.feederRelative === 2 ? 3 : this.feederRelative
    let t = [this.a.encodeTenhou().toString(), this.b.encodeTenhou().toString(), this.c.encodeTenhou().toString()]
    t.splice(pos, 0, `m${this.tile.encodeTenhou()}`)
    return t.join('')
  }
}

class AnkanSymbol {
  constructor(tile) { this.tile = tile }
  encodeTenhou() {
    let t = this.tile.encodeTenhou()
    if (this.tile.num === 5 && this.tile.type !== TileType.Z) {
      return `${new Tile(0, this.tile.type).encodeTenhou()}${t}${t}a${t}`
    }
    return `${t}${t}${t}a${t}`
  }
}

class PeSymbol {
  encodeTenhou() { return "f44" }
}

class KakanSymbol {
  constructor(a, b, c, tile, feederRelative) {
    this.a = a; this.b = b; this.c = c; this.tile = tile; this.feederRelative = feederRelative
  }
  encodeTenhou() {
    let t = [this.a.encodeTenhou().toString(), this.b.encodeTenhou().toString(), this.c.encodeTenhou().toString()]
    t.splice(this.feederRelative, 0, `k${this.tile.encodeTenhou()}`)
    return t.join('')
  }
}

class ZeroSymbol {
  encodeTenhou() { return 0 }
}

class SpecialRyukyoku {
  static kyushukyuhai = 1; static sufonrenda = 2; static suuchariichi = 3; static suukaikan = 4; static sanchahou = 5
  static dump(val) {
    if (val === this.kyushukyuhai) return [RUNES.kyuushukyuuhai[JPNAME]]
    if (val === this.sufonrenda) return [RUNES.suufonrenda[JPNAME]]
    if (val === this.suuchariichi) return [RUNES.suuchariichi[JPNAME]]
    if (val === this.suukaikan) return [RUNES.suukaikan[JPNAME]]
    if (val === this.sanchahou) return [RUNES.sanchahou[JPNAME]]
    return []
  }
}

class Ryukyoku {
  constructor(delta, nagashimangan) { this.delta = delta; this.nagashimangan = nagashimangan }
  dump() {
    return [this.nagashimangan ? RUNES.nagashimangan[JPNAME] : RUNES.ryuukyoku[JPNAME], this.delta]
  }
}

const AgariPointLevel = { yakuman: 0, sanbaiman: 1, baiman: 2, haneman: 3, mangan: 4 }

class AgariPoint {
  constructor(ron = 0, tsumo = 0, tsumo_oya = 0, oya = false) {
    this.ron = ron; this.tsumo = tsumo; this.tsumo_oya = tsumo_oya; this.oya = oya
  }
  get level() {
    let judgement = 0
    if (this.ron === 0) {
      judgement = this.oya ? Math.floor(this.tsumo * 3 / 1.5) : (this.tsumo * 2 + this.tsumo_oya)
    } else {
      judgement = this.oya ? Math.floor(this.ron / 1.5) : this.ron
    }
    if (judgement >= 32000) return AgariPointLevel.yakuman
    if (judgement >= 24000) return AgariPointLevel.sanbaiman
    if (judgement >= 16000) return AgariPointLevel.baiman
    if (judgement >= 12000) return AgariPointLevel.haneman
    if (judgement >= 8000) return AgariPointLevel.mangan
    return null
  }
}

class Yaku {
  constructor(id, val) { this.id = id; this.val = val }
  name(round, seat) {
    const WIND = ["east", "south", "west", "north"]
    if (this.id === 10) return `${RUNES.jikaze[JPNAME]} ${RUNES[WIND[(seat + round.kyoku) % 4]][JPNAME]}`
    if (this.id === 11) return `${RUNES.bakaze[JPNAME]} ${RUNES[WIND[Math.floor(round.kyoku / 4)]][JPNAME]}`
    if (this.id === 18) return RUNES.dabururiichi[JPNAME]
    return cfg.fan.fan.map_[this.id.toString()].name_jp
  }
}

class Kyoku {
  constructor(nplayers, round, initscores, doras, draws, discards, haipais, poppedtile, dealerseat) {
    this.nplayers = nplayers; this.round = round; this.initscores = initscores; this.doras = doras;
    this.draws = draws; this.discards = discards; this.haipais = haipais; this.poppedtile = poppedtile;
    this.dealerseat = dealerseat; this.ldseat = -1; this.nriichi = 0; this.priichi = false; this.nkan = 0;
    this.nowinds = [0,0,0,0]; this.nodrags = [0,0,0,0]; this.paowind = -1; this.paodrag = -1; this.result = null
  }
  countpao(tile, owner, feeder) {
    const WINDS = [new Tile(1,3), new Tile(2,3), new Tile(3,3), new Tile(4,3)]
    const DRAGS = [new Tile(5,3), new Tile(6,3), new Tile(7,3), new Tile(0,3)]
    if (WINDS.some(t => t.equals(tile))) {
      this.nowinds[owner]++
      if (this.nowinds[owner] === 4) this.paowind = feeder
    } else if (DRAGS.some(t => t.equals(tile))) {
      this.nodrags[owner]++
      if (this.nodrags[owner] === 3) this.paodrag = feeder
    }
  }
  dump() {
    let entry = [[this.round.kyoku, this.round.honba, this.round.riichi_sticks], this.initscores, this.doras.map(t=>t.encodeTenhou())]
    if (this.result && this.result.uras) entry.push(this.result.uras.map(t=>t.encodeTenhou()))
    else entry.push([])
    
    for (let i=0; i<this.nplayers; i++) {
      entry.push(this.haipais[i].map(t=>t.encodeTenhou()))
      entry.push(this.draws[i].map(t=>t.encodeTenhou()))
      entry.push(this.discards[i].map(t=>t.encodeTenhou()))
    }
    if (this.result) entry.push(this.result.dump())
    return entry
  }
}

export class MajsoulPaipuParser {
  constructor() {
    this.kyokus = []
    this.kyoku = null
    this.tsumolossOff = false
  }
  
  handleGameRecord(record) {
    let res = {
      ver: "2.3", ref: record.head.uuid, ratingc: "", rule: {}, lobby: 0, dan: [], rate: [], sx: [], name: [], sc: [], title: [], log: [], levelId: [], avatarId: []
    }
    let nplayers = record.head.result.players.length
    let nakas = nplayers - 1
    res.ratingc = `PF${nplayers}`
    let ruledisp = ""
    if (nplayers === 3) ruledisp += RUNES.sanma[JPNAME]
    
    if (record.head.config.meta.mode_id) {
      ruledisp += cfg.desktop.matchmode.map_[record.head.config.meta.mode_id.toString()].room_name_jp
    } else if (record.head.config.meta.room_id) {
      res.lobby = 0
      ruledisp += RUNES.friendly[JPNAME]
      nakas = record.head.config.mode.detail_rule.dora_count
      this.tsumolossOff = nplayers === 3 && !record.head.config.mode.detail_rule.have_zimosun
    } else if (record.head.config.meta.contest_uid) {
      res.lobby = 0
      ruledisp += RUNES.tournament[JPNAME]
      nakas = record.head.config.mode.detail_rule.dora_count
      this.tsumolossOff = nplayers === 3 && !record.head.config.mode.detail_rule.have_zimosun
    }
    
    if (record.head.config.mode.mode === 1) ruledisp += RUNES.tonpuu[JPNAME]
    else if (record.head.config.mode.mode === 2) ruledisp += RUNES.hanchan[JPNAME]
    
    if (record.head.config.meta.mode_id === 0 && record.head.config.mode.detail_rule.dora_count === 0) {
      res.rule = { disp: ruledisp, aka53: 0, aka52: 0, aka51: 0 }
    } else {
      res.rule = { disp: ruledisp, aka53: 1, aka52: nakas === 4 ? 2 : 1, aka51: nplayers === 4 ? 1 : 0 }
    }
    
    res.dan = Array(nplayers).fill("")
    res.rate = Array(nplayers).fill(0)
    res.name = Array(nplayers).fill("AI")
    res.sx = Array(nplayers).fill("C")
    
    for (let e of record.head.accounts) {
      res.dan[e.seat] = cfg.level_definition.level_definition.map_[e.level.id.toString()].full_name_jp
      res.rate[e.seat] = e.level.score
      res.name[e.seat] = e.nickname
      res.levelId[e.seat] = e.level.id
      res.avatarId[e.seat] = e.avatar_id
    }
    if (nplayers === 3) { res.name[3] = ""; res.sx[3] = "" }
    
    res.sc = Array(nplayers * 2).fill(0.0)
    for (let e of record.head.result.players) {
      res.sc[2 * e.seat] = e.part_point_1
      res.sc[2 * e.seat + 1] = e.total_point / 1000.0
    }
    res.title = [ruledisp, new Date(record.head.end_time * 1000).toLocaleString('sv-SE').replace('T', ' ')]
    
    for (let item of record.data) {
      this.handle(item)
    }
    res.log = this.kyokus.map(k => k.dump())
    return res
  }

  handle(log) {
    switch (log.name) {
      case "RecordNewRound": this._handleNewRound(log.data); break;
      case "RecordDiscardTile": this._handleDiscardTile(log.data); break;
      case "RecordDealTile": this._handleDealTile(log.data); break;
      case "RecordChiPengGang": this._handleChiPengGang(log.data); break;
      case "RecordAnGangAddGang": this._handleAnGangAddGang(log.data); break;
      case "RecordBaBei": this._handleBaBei(log.data); break;
      case "RecordLiuJu": this._handleLiuJu(log.data); break;
      case "RecordNoTile": this._handleNoTile(log.data); break;
      case "RecordHule": this._handleHuLe(log.data); break;
    }
  }

  _handleNewRound(log) {
    let nplayers = log.scores.length
    this.kyoku = new Kyoku(nplayers, {kyoku: 4*log.chang + log.ju, honba: log.ben, riichi_sticks: log.liqibang},
      padList(log.scores, 4, 0),
      log.dora ? [Tile.parse(log.dora)] : log.doras.map(t=>Tile.parse(t)),
      [[],[],[],[]], [[],[],[],[]],
      Array.from({length: nplayers}, (_,i) => (log[`tiles${i}`] || []).map(t=>Tile.parse(t))),
      new Tile(0, TileType.M), log.ju)
    this.kyoku.draws[log.ju].push(this.kyoku.haipais[log.ju].pop())
  }

  _handleDiscardTile(log) {
    let tile = Tile.parse(log.tile)
    let tsumogiri = log.moqie
    if (log.seat === this.kyoku.dealerseat && this.kyoku.discards[log.seat].length === 0 && tile.equals(this.kyoku.poppedtile)) {
      tsumogiri = true
    }
    let sym = new DiscardSymbol(tile, tsumogiri)
    if (log.is_liqi) {
      this.kyoku.priichi = true
      sym = new DiscardSymbol(sym.tile, sym.tsumogiri, true)
    }
    this.kyoku.discards[log.seat].push(sym)
    this.kyoku.ldseat = log.seat
    if (log.doras && log.doras.length > this.kyoku.doras.length) {
      this.kyoku.doras = log.doras.map(t=>Tile.parse(t))
    }
  }

  _acceptRiichi() {
    if (this.kyoku.priichi) {
      this.kyoku.priichi = false
      this.kyoku.nriichi++
    }
  }

  _handleDealTile(log) {
    this._acceptRiichi()
    if (log.doras && log.doras.length > this.kyoku.doras.length) {
      this.kyoku.doras = log.doras.map(t=>Tile.parse(t))
    }
    this.kyoku.draws[log.seat].push(Tile.parse(log.tile))
  }

  _handleChiPengGang(log) {
    this._acceptRiichi()
    let seat = log.seat
    if (log.type === 0) {
      this.kyoku.draws[seat].push(new ChiSymbol(Tile.parse(log.tiles[2]), Tile.parse(log.tiles[0]), Tile.parse(log.tiles[1])))
    } else if (log.type === 1) {
      let wt = log.tiles.map(t=>Tile.parse(t))
      let idx = relativeSeating(seat, this.kyoku.ldseat)
      this.kyoku.countpao(wt[0], seat, this.kyoku.ldseat)
      this.kyoku.draws[seat].push(new PonSymbol(wt[0], wt[1], wt[2], idx))
    } else if (log.type === 2) {
      let wt = log.tiles.map(t=>Tile.parse(t))
      let idx = relativeSeating(seat, this.kyoku.ldseat)
      this.kyoku.countpao(wt[0], seat, this.kyoku.ldseat)
      this.kyoku.draws[seat].push(new DaiminkanSymbol(wt[0], wt[1], wt[2], wt[3], idx))
      this.kyoku.discards[seat].push(new ZeroSymbol())
      this.kyoku.nkan++
    }
  }

  _handleAnGangAddGang(log) {
    let tile = Tile.parse(log.tiles)
    this.kyoku.ldseat = log.seat
    if (log.type === 3) {
      this.kyoku.countpao(tile, log.seat, -1)
      let ankantiles = this.kyoku.haipais[log.seat].filter(t=>t.deaka().equals(tile.deaka())).concat(
        this.kyoku.draws[log.seat].filter(t=> t instanceof Tile && t.deaka().equals(tile.deaka()))
      )
      let ankanTile = ankantiles.length ? ankantiles.pop() : tile
      this.kyoku.discards[log.seat].push(new AnkanSymbol(ankanTile.deaka()))
      this.kyoku.nkan++
    } else if (log.type === 2) {
      for (let i=0; i<this.kyoku.draws[log.seat].length; i++) {
        let sy = this.kyoku.draws[log.seat][i]
        if (sy instanceof PonSymbol && (sy.tile.equals(tile) || sy.tile.equals(tile.deaka()))) {
          this.kyoku.draws[log.seat].splice(i, 1)
          this.kyoku.discards[log.seat].push(new KakanSymbol(sy.a, sy.b, sy.tile, tile, sy.feederRelative))
          this.kyoku.nkan++
          break
        }
      }
    }
  }

  _handleBaBei(log) {
    this.kyoku.discards[log.seat].push(new PeSymbol())
    this.kyoku.ldseat = log.seat
  }

  _handleLiuJu(log) {
    this._acceptRiichi()
    if (log.type === 1) this.kyoku.result = { dump: () => SpecialRyukyoku.dump(1) }
    else if (log.type === 2) this.kyoku.result = { dump: () => SpecialRyukyoku.dump(2) }
    else if (this.kyoku.nriichi === 4) this.kyoku.result = { dump: () => SpecialRyukyoku.dump(3) }
    else if (this.kyoku.nkan === 4) this.kyoku.result = { dump: () => SpecialRyukyoku.dump(4) }
    
    this.kyokus.push(this.kyoku)
    this.kyoku = null
  }

  _handleNoTile(log) {
    let delta = [0,0,0,0]
    if (log.scores && log.scores.length > 0 && log.scores[0].delta_scores && log.scores[0].delta_scores.length > 0) {
      for (let score of log.scores) {
        for (let i=0; i<score.delta_scores.length; i++) {
          delta[i] += score.delta_scores[i]
        }
      }
    }
    this.kyoku.result = new Ryukyoku(delta, log.liujumanguan || false)
    this.kyokus.push(this.kyoku)
    this.kyoku = null
  }

  _tlround(x) {
    return this.tsumolossOff ? 100 * Math.ceil(x / 100) : 0
  }

  _parseHuLe(hule, isHeadBump) {
    let delta = [0,0,0,0]
    let points = null
    let rp = isHeadBump ? 1000 * (this.kyoku.nriichi + this.kyoku.round.riichi_sticks) : 0
    let hb = isHeadBump ? 100 * this.kyoku.round.honba : 0
    
    let pao = false, liableseat = -1, liablefor = 0
    if (hule.yiman) {
      for (let e of hule.fans) {
        if (e.id === DAISUUSHI && this.kyoku.paowind !== -1) { pao = true; liableseat = this.kyoku.paowind; liablefor += e.val }
        else if (e.id === DAISANGEN && this.kyoku.paodrag !== -1) { pao = true; liableseat = this.kyoku.paodrag; liablefor += e.val }
      }
    }

    if (hule.zimo) {
      let tlround_part = this._tlround(0.5 * hule.point_zimo_xian)
      for (let i=0; i<this.kyoku.nplayers; i++) delta[i] = -hb - hule.point_zimo_xian - tlround_part
      if (hule.seat === this.kyoku.dealerseat) {
        delta[hule.seat] = rp + (this.kyoku.nplayers - 1) * (hb + hule.point_zimo_xian) + 2 * tlround_part
        points = new AgariPoint(0, hule.point_zimo_xian + tlround_part, 0, true)
      } else {
        delta[hule.seat] = rp + hb + hule.point_zimo_qin + (this.kyoku.nplayers - 2) * (hb + hule.point_zimo_xian) + 2 * tlround_part
        delta[this.kyoku.dealerseat] = -hb - hule.point_zimo_qin - tlround_part
        points = new AgariPoint(0, hule.point_zimo_xian, hule.point_zimo_qin, false)
      }
    } else {
      delta = [0,0,0,0]
      delta[hule.seat] = rp + (this.kyoku.nplayers - 1) * hb + hule.point_rong
      delta[this.kyoku.ldseat] = -(this.kyoku.nplayers - 1) * hb - hule.point_rong
      points = new AgariPoint(hule.point_rong, 0, 0, hule.qinjia)
    }

    if (pao) {
      const OYA=0, KO=1, RON=2
      if (hule.zimo) {
        if (hule.qinjia) {
          let tlround_part = this._tlround(0.5 * liablefor * YSCORE[OYA][KO])
          delta[liableseat] -= 2*hb + liablefor * 2 * YSCORE[OYA][KO] + tlround_part
          for (let i=0; i<delta.length; i++) {
            if (liableseat !== i && hule.seat !== i && this.kyoku.nplayers >= i) {
              delta[i] += hb + liablefor * YSCORE[OYA][KO] + tlround_part
            }
          }
          if (this.kyoku.nplayers === 3) delta[hule.seat] += this.tsumolossOff ? 0 : liablefor * YSCORE[OYA][KO]
        } else {
          let tlround_part = this._tlround(0.5 * liablefor * YSCORE[KO][KO])
          delta[liableseat] -= (this.kyoku.nplayers - 2) * hb + liablefor * (YSCORE[KO][OYA] + YSCORE[KO][KO]) + tlround_part
          for (let i=0; i<delta.length; i++) {
            if (liableseat !== i && hule.seat !== i && this.kyoku.nplayers >= i) {
              if (this.kyoku.dealerseat === i) delta[i] += hb + liablefor * YSCORE[KO][OYA] + tlround_part
              else delta[i] += hb + liablefor * YSCORE[KO][KO] + tlround_part
            }
          }
        }
      } else {
        let points_ron = liablefor * YSCORE[hule.qinjia ? OYA : KO][RON]
        let player_num = this.kyoku.nplayers - 1
        delta[liableseat] -= Math.floor(player_num * hb + 0.5 * points_ron)
        delta[this.kyoku.ldseat] += Math.floor(player_num * hb + 0.5 * points_ron)
      }
    }
    
    return {
      seat: hule.seat, ldseat: hule.zimo ? hule.seat : this.kyoku.ldseat, paoseat: pao ? liableseat : hule.seat,
      han: hule.count, fu: hule.fu, yaku: hule.fans.map(e=>new Yaku(e.id, e.val)), oya: hule.qinjia,
      tsumo: hule.zimo, yakuman: hule.yiman, point: points, delta: delta
    }
  }

  _handleHuLe(log) {
    let agari = [], ura = [], isHeadBump = true
    for (let f of log.hules) {
      if (f.li_doras && ura.length < f.li_doras.length) ura = f.li_doras.map(t=>Tile.parse(t))
      agari.push(this._parseHuLe(f, isHeadBump))
      isHeadBump = false
    }
    this.kyoku.result = {
      uras: ura,
      dump: () => {
        let li = [RUNES.agari[JPNAME]]
        for (let a of agari) {
          li.push(padList(a.delta, 4, 0))
          let res = [a.seat, a.ldseat, a.paoseat]
          let point = ""
          if (a.tsumo) {
            if (a.oya) point = `${a.point.tsumo}${RUNES.points[JPNAME]}${RUNES.all[JPNAME]}`
            else point = `${a.point.tsumo}-${a.point.tsumo_oya}${RUNES.points[JPNAME]}`
          } else {
            point = `${a.point.ron}${RUNES.points[JPNAME]}`
          }
          let fuhan = `${a.fu}${RUNES.fu[JPNAME]}${a.han}${RUNES.han[JPNAME]}`
          let level = a.point.level
          if (level === AgariPointLevel.yakuman) {
            point = (a.han >= 13 ? RUNES.kazoeyakuman[JPNAME] : RUNES.yakuman[JPNAME]) + point
            fuhan = ""
          } else if (level === AgariPointLevel.sanbaiman) { point = RUNES.sanbaiman[JPNAME] + point; fuhan = "" }
          else if (level === AgariPointLevel.baiman) { point = RUNES.baiman[JPNAME] + point; fuhan = "" }
          else if (level === AgariPointLevel.haneman) { point = RUNES.haneman[JPNAME] + point; fuhan = "" }
          else if (level === AgariPointLevel.mangan) {
            if (a.han >= 5 || (a.han >= 4 && a.fu >= 40) || (a.han >= 3 && a.fu >= 70)) point = RUNES.mangan[JPNAME] + point
            else point = RUNES.kiriagemangan[JPNAME] + point
            fuhan = ""
          }
          res.push(fuhan + point)
          for (let e of a.yaku) {
            let name = e.name(this.kyoku.round, a.seat)
            res.push(a.yakuman ? `${name}(${RUNES.yakuman[JPNAME]})` : `${name}(${e.val}${RUNES.han[JPNAME]})`)
          }
          li.push(res)
        }
        return li
      }
    }
    this.kyokus.push(this.kyoku)
    this.kyoku = null
  }
}
