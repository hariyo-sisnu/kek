# Apple of Fortune

## 1. Game Concept

Apple of Fortune is a grid-based risk/reward game with **10 levels and 5 cells per level**.

The player places a stake and selects one hidden cell at each level:

- **Safe Apple** → advance to the next level and increase the multiplier.
- **Poisoned Apple** → round ends and the stake is lost.
- **Cash Out** → player can collect the current multiplier after any successful level.

```text
10 Levels × 5 Cells = 50 Playable Cells
```

## 2. Grid

The game contains 10 vertical levels:

```text
Level 10   [ ] [ ] [ ] [ ] [ ]
Level 9    [ ] [ ] [ ] [ ] [ ]
Level 8    [ ] [ ] [ ] [ ] [ ]
Level 7    [ ] [ ] [ ] [ ] [ ]
Level 6    [ ] [ ] [ ] [ ] [ ]
Level 5    [ ] [ ] [ ] [ ] [ ]
Level 4    [ ] [ ] [ ] [ ] [ ]
Level 3    [ ] [ ] [ ] [ ] [ ]
Level 2    [ ] [ ] [ ] [ ] [ ]
Level 1    [ ] [ ] [ ] [ ] [ ]
```

The player starts at Level 1 and progresses upward.

## 3. Poisoned Apples

The number of poisoned apples increases by level:

| Levels | Poisoned | Safe |
|---|---:|---:|
| 1–4 | 1 | 4 |
| 5–7 | 2 | 3 |
| 8–10 | 3 | 2 |

Each level contains exactly 5 cells.

## 4. Multipliers

| Level | Multiplier |
|---:|---:|
| 1 | 1.23× |
| 2 | 1.54× |
| 3 | 1.93× |
| 4 | 2.41× |
| 5 | 4.02× |
| 6 | 6.71× |
| 7 | 11.18× |
| 8 | 27.92× |
| 9 | 69.93× |
| 10 | 349.68× |

Payout is calculated from the original stake:

```text
Payout = Stake × Current Multiplier
```

## 5. Game Flow

```text
Place Stake
    ↓
Level 1
    ↓
Select Cell
    ↓
Safe? ── No → Lose
  │
 Yes
  ↓
Increase Multiplier
  ↓
Cash Out? ── Yes → Payout
  │
 No
  ↓
Next Level
```

The process continues until the player cashes out, hits a poisoned apple, or completes Level 10.

## 6. Core Game State

The backend should maintain:

```text
round_id
player_id
stake
current_level
current_multiplier
cell_results
selected_cells
status
payout
```

Possible statuses:

```text
ACTIVE
LOST
CASHED_OUT
COMPLETED
```

## 7. Responsibilities

### Backend

- Generate cell results
- Validate selections
- Control level progression
- Calculate multipliers and payouts
- Process cash-outs
- Settle the round

### Frontend

- Render the 5×10 grid
- Display apples and multipliers
- Handle player selection
- Animate reveals
- Display win/loss states
- Provide the cash-out interface

**The backend must be authoritative for game results and payouts.**