# Design notes

Working title **Temasek 1360**. An original-IP MMO adventure that draws on RuneScape (skills,
quests, trading, sandbox) and the Voya Nui Online Game (element wheel, grid combat, chapters
gated by bosses, the fear of what's past the next part of the map).

## Decided

- **Progression is per player.** Nothing is gated server-wide.
- **Complete solo.** It must be fully playable with one person online. Playing with others gives
  only small bonuses: mostly co-op, with competition only in festival minigames.
- **Setting:** the Temasek river mouth at the height of trade. Majapahit leads the look and the
  culture, but China stays in as a trading partner (see the cultural notes below).
- **Premise:** something fell from another planet into the Strait and is waking up. Futuristic,
  but not too futuristic, and grown rather than built.
- **The monsoon and wind are a core mechanic.**
- **Six elements, each beating the next:** Kayu > Tanah > Angin > Air > Api > Besi > Kayu.
- **Skills have Malay names.** A small set ships at launch and more arrive one monsoon at a time.
- **Camera and combat:** isometric camera; turn-based grid combat (Dofus style), not menu combat.
- **Art:** wayang kulit, with painted puppets standing on the board.
- **Not a rhythm game.** Timing helps and never punishes: a miss is a normal hit, never a fail.
- **Movement:** walk by default. Kite travel is gated in some way (not built yet).
- **Sessions:** short. Chapters are cut into acts (*babak*), and each chapter ends with a pirate
  lord who must be on theme and culturally accurate.
- **The first hour is a pilot episode** that should feel like a complete story.

## Tentative (built this way in the MVP; confirm or change)

| Topic | MVP choice | Notes |
|---|---|---|
| Who the player is | Crew regrown from a seed pod, in a local body | Explains respawning and why there are many heroes. Pak Lawak thinks you're a prawn. |
| Year | About 1360 | Hayam Wuruk reigns and Gajah Mada is chief minister until 1364. Private Chinese trade is still open (the Ming ban comes in 1371). |
| Launch skills | Pancing (fishing), Dagang (trading), Silat (fighting) | Layar, Wayang, Selam, Tempa and Jamu show as "Musim 2–4" in the Skills tab. |
| Your element | Air (water) | Chapter 1's perompak are Api, so the wheel teaches itself. |
| Companion | Pak Lawak, a clown companion (punakawan-inspired, but original, not Semar) | Fills the party when no friend is online. |
| Signature system | Shadow puppets: the dalang cuts Si Todak's shadow into *Bayang Todak*, a once-per-fight move | Only a teaser in Act 1. |
| Monsoon length | 500 ticks, about 5 real minutes | Short so one session sees the wind turn. A real build would be longer. |
| Economy | Picis coins; Mak Cik Rahmah buys everything; the monsoon trader pays ×1.75 for one fish minus a 10% harbour tax; jamu and gear are the money sinks | No player market yet. |
| Timing bonus | Attacks: ×1.25 perfect, ×1.1 good. Dodges: ×0.6 perfect, ×0.8 good | "Auto timing" always gives "good". |
| XP curve | RuneScape's, level 2 at 83 XP | Act 1 ends around Pancing 5, Dagang 3, Silat 3. |

## Open

- Pirate lords: how many, whether there's one per element, and their names. Si Todak is the
  Act 1 lieutenant, not the chapter lord.
- How much of the theme is biomechanical or bio-organic. The pod is the only alien thing so far.
- How the kite gate works (kite hills plus monsoon direction was proposed).
- How mastery and the skill cap stay deep without hurting the first hour.
- Multiplayer: interest management, persistence, trading, hosting (see the roadmap in `NOTES.md`).

## Rejected

- Server-wide gating
- Hades-style runs
- "Grafting"
- The sea-chart look
- Side-view camera and menu fights
- The board-plus-screen "two sides" idea
- Rhythm as the core mechanic
- The performance-show idea
- Kites as the main way to explore

## Cultural and historical notes

- **Orang Laut** are a living people. Villains are a fictional crew of *perompak* (pirates).
  Avoid *lanun*, which comes from an ethnonym.
- **Wang Dayuan** (visited around 1330, book finished 1349) recorded pirates at Longyamen,
  Dragon's Tooth Gate.
- **The word "Keling" is derogatory** in Malaysia; don't use it. The Indian-Ocean trader is from
  Gujarat.
- **Chinese influence was real.** Majapahit's everyday money was imported Chinese copper cash, and
  there was a Chinese community at Temasek. The Quanzhou junk trader reflects that.
- **Punakawan (Semar and the others) are revered** as well as comic. Pak Lawak is an original
  clown inspired by the type, not a copy of a named figure.
- **Bukit Larangan** (Fort Canning) really was the "forbidden hill". The split gate (*candi
  bentar*) and red-tiled pendopo follow Majapahit forms.
- **Quest hooks for later acts:** the lion that wasn't, the swordfish attack, Badang the strongman,
  and the undeciphered Singapore Stone.
- **Clean room:** nothing here comes from the Voya Nui remake (no code, data, names, maps or
  dialogue).
