class ShaUtils {
  static hmacSha512 = CryptoJS.HmacSHA512;
  static sha256 = CryptoJS.SHA256;
}

const CARD_SUITS = ['CLUBS', 'SPADES', 'HEARTS', 'DIAMONDS'];
const CARD_RANKS = ['TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'JACK', 'QUEEN', 'KING', 'ACE'];
const DISPLAY_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT_SYMBOLS = {
  CLUBS: '♣',
  DIAMONDS: '♦',
  HEARTS: '♥',
  SPADES: '♠'
};

const DEAL_ORDER_LABELS = ['Player 1', 'Banker 1', 'Player 2', 'Banker 2', 'Player 3', 'Banker 3'];

class RoundHashes {
  static HASHES_COUNT = 2;

  // Round hashes: hmacSha512("clientSeed:nonce:i", serverSeed) for i in [0, 2).
  static calculate(serverSeed, clientSeed, nonce) {
    const hashes = [];
    for (let i = 0; i < this.HASHES_COUNT; i++) {
      hashes.push(ShaUtils.hmacSha512(this.message(clientSeed, nonce, i), serverSeed).toString());
    }
    return hashes;
  }

  static message(clientSeed, nonce, index) {
    return `${clientSeed}:${nonce}:${index}`;
  }
}

// Mirrors BaccaratCardsGenerator: 6 cards, card j = unsigned 32-bit int from hex chars [8j, 8j + 8), mapped by (u * 52) >> 32.
class CardsGenerator {
  static CARDS_COUNT = 6;
  static CHARS_PER_CARD = 8;
  static DECK_SIZE = 52;
  static TWO_POW_32 = 4294967296;

  static getCards(hashes) {
    const finalHash = hashes.join('');
    const requiredHexChars = this.CARDS_COUNT * this.CHARS_PER_CARD;

    if (finalHash.length < requiredHexChars) {
      throw new Error(`Combined hash length ${finalHash.length} is less than required ${requiredHexChars}`);
    }

    const draws = [];
    for (let card = 0; card < this.CARDS_COUNT; card++) {
      const from = card * this.CHARS_PER_CARD;
      const hex = finalHash.substring(from, from + this.CHARS_PER_CARD);
      const u = parseInt(hex, 16);
      // u * 52 < 2^38 and the divisor is a power of two, so this is exact integer arithmetic
      const code = Math.floor((u * this.DECK_SIZE) / this.TWO_POW_32);
      draws.push({ hex, u, code });
    }
    return draws;
  }
}

class Card {
  static rankIndex(code) {
    return Math.floor(code / 4);
  }

  static suit(code) {
    return CARD_SUITS[code % 4];
  }

  static rank(code) {
    return CARD_RANKS[this.rankIndex(code)];
  }

  static displayRank(code) {
    return DISPLAY_RANKS[this.rankIndex(code)];
  }

  static label(code) {
    return `${this.displayRank(code)}${SUIT_SYMBOLS[this.suit(code)]}`;
  }
}

// Mirrors BaccaratRoundSettler: naturals plus the standard punto banco third-card tableau.
class RoundSettler {
  static OUTCOME_PLAYER = 'PLAYER';
  static OUTCOME_BANKER = 'BANKER';
  static OUTCOME_TIE = 'TIE';

  static ACE_RANK = 12;
  static TEN_RANK = 8;

  static cardValue(code) {
    if (code < 0 || code >= 52) {
      throw new Error(`Card code ${code} is out of range 0..51`);
    }

    const rank = Card.rankIndex(code);
    if (rank === this.ACE_RANK) {
      return 1;
    }
    if (rank >= this.TEN_RANK) {
      return 0;
    }
    return rank + 2;
  }

  static settle(cards) {
    if (cards.length !== CardsGenerator.CARDS_COUNT) {
      throw new Error(`Cards count ${cards.length} differs from expected ${CardsGenerator.CARDS_COUNT}`);
    }

    const playerInitialTotal = (this.cardValue(cards[0]) + this.cardValue(cards[2])) % 10;
    const bankerInitialTotal = (this.cardValue(cards[1]) + this.cardValue(cards[3])) % 10;
    let playerTotal = playerInitialTotal;
    let bankerTotal = bankerInitialTotal;

    const natural = playerTotal >= 8 || bankerTotal >= 8;
    const playerDraws = !natural && playerTotal <= 5;

    let playerThirdValue = -1;
    if (playerDraws) {
      playerThirdValue = this.cardValue(cards[4]);
      playerTotal = (playerTotal + playerThirdValue) % 10;
    }

    const bankerDraws = !natural && this.bankerDrawsThird(bankerTotal, playerDraws, playerThirdValue);
    if (bankerDraws) {
      bankerTotal = (bankerTotal + this.cardValue(cards[5])) % 10;
    }

    const playerCards = playerDraws ? [cards[0], cards[2], cards[4]] : [cards[0], cards[2]];
    const bankerCards = bankerDraws ? [cards[1], cards[3], cards[5]] : [cards[1], cards[3]];

    const outcome = playerTotal === bankerTotal
      ? this.OUTCOME_TIE
      : (playerTotal > bankerTotal ? this.OUTCOME_PLAYER : this.OUTCOME_BANKER);

    return {
      playerCards,
      bankerCards,
      playerInitialTotal,
      bankerInitialTotal,
      playerTotal,
      bankerTotal,
      natural,
      playerDraws,
      playerThirdValue,
      bankerDraws,
      outcome
    };
  }

  static bankerDrawsThird(bankerTotal, playerDrew, playerThirdValue) {
    if (!playerDrew) {
      return bankerTotal <= 5;
    }

    switch (bankerTotal) {
      case 0:
      case 1:
      case 2:
        return true;
      case 3:
        return playerThirdValue !== 8;
      case 4:
        return playerThirdValue >= 2 && playerThirdValue <= 7;
      case 5:
        return playerThirdValue >= 4 && playerThirdValue <= 7;
      case 6:
        return playerThirdValue === 6 || playerThirdValue === 7;
      default:
        return false;
    }
  }
}

// Mirrors BaccaratPayoutCalculator: return of one staked unit in cents.
class PayoutCalculator {
  static PLAYER_WIN_RETURN_CENTS = 200;
  static BANKER_WIN_RETURN_CENTS = 195;
  static TIE_WIN_RETURN_CENTS = 900;
  static PUSH_RETURN_CENTS = 100;

  static BET_TYPES = ['PLAYER', 'BANKER', 'TIE'];

  static getReturnCents(betType, outcome) {
    if (outcome === RoundSettler.OUTCOME_TIE) {
      return betType === 'TIE' ? this.TIE_WIN_RETURN_CENTS : this.PUSH_RETURN_CENTS;
    }

    switch (betType) {
      case 'PLAYER':
        return outcome === RoundSettler.OUTCOME_PLAYER ? this.PLAYER_WIN_RETURN_CENTS : 0;
      case 'BANKER':
        return outcome === RoundSettler.OUTCOME_BANKER ? this.BANKER_WIN_RETURN_CENTS : 0;
      default:
        return 0;
    }
  }
}

class RoundResolver {
  static getData(serverSeed, nonce, clientSeed) {
    const hashes = RoundHashes.calculate(serverSeed, clientSeed, nonce);
    const draws = CardsGenerator.getCards(hashes);
    const result = RoundSettler.settle(draws.map(draw => draw.code));

    return {
      sha256: ShaUtils.sha256(serverSeed).toString(),
      hashes,
      draws,
      result
    };
  }
}

let appState = {
  serverSeed: '',
  nonce: '',
  clientSeed: '',
  data: null,
  error: ''
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateResults() {
  appState.data = null;
  appState.error = '';

  if (appState.serverSeed && appState.clientSeed) {
    try {
      appState.data = RoundResolver.getData(appState.serverSeed, appState.nonce, appState.clientSeed);
    } catch (error) {
      console.error('Error calculating results:', error);
      appState.error = error.message;
    }
  }

  renderResults();
}

function renderResults() {
  const data = appState.data;

  document.getElementById('sha256-input').value = data ? data.sha256 : '';
  document.getElementById('hash-0-input').value = data ? data.hashes[0] : '';
  document.getElementById('hash-1-input').value = data ? data.hashes[1] : '';

  const resultContainer = document.getElementById('baccarat-result');
  const explanationContainer = document.getElementById('explanation-section');

  if (!data) {
    resultContainer.innerHTML = appState.error ? `<div class="error">${escapeHtml(appState.error)}</div>` : '';
    explanationContainer.innerHTML = '';
    return;
  }

  renderRoundResult(resultContainer, data.result);
  renderExplanation(explanationContainer, data);
}

function createCardElement(code) {
  const suit = Card.suit(code);
  const displayRank = Card.displayRank(code);

  const cardElement = document.createElement('div');
  cardElement.className = `card ${suit === 'HEARTS' || suit === 'DIAMONDS' ? 'red' : 'black'}`;

  for (let i = 0; i < 2; i++) {
    const cardTextElement = document.createElement('div');
    cardTextElement.className = 'card-text';
    const rankElement = document.createElement('div');
    rankElement.textContent = displayRank;
    const suitElement = document.createElement('div');
    suitElement.textContent = SUIT_SYMBOLS[suit];
    cardTextElement.appendChild(rankElement);
    cardTextElement.appendChild(suitElement);
    cardElement.appendChild(cardTextElement);
  }

  return cardElement;
}

function createHandSection(title, className, cards, total, isWinner) {
  const section = document.createElement('div');
  section.className = `hand-section ${className}${isWinner ? ' winner' : ''}`;

  const header = document.createElement('div');
  header.className = 'hand-title';
  header.textContent = `${title} — ${total}`;

  const cardsContainer = document.createElement('div');
  cardsContainer.className = 'hand-cards';
  cards.forEach(code => cardsContainer.appendChild(createCardElement(code)));

  section.appendChild(header);
  section.appendChild(cardsContainer);
  return section;
}

function renderRoundResult(container, result) {
  container.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'text';
  title.textContent = 'This is the round result, dealt from the cards generated from the round hashes:';

  const hands = document.createElement('div');
  hands.className = 'baccarat-hands';
  hands.appendChild(createHandSection('Player', 'player-section', result.playerCards, result.playerTotal, result.outcome === RoundSettler.OUTCOME_PLAYER));
  hands.appendChild(createHandSection('Banker', 'banker-section', result.bankerCards, result.bankerTotal, result.outcome === RoundSettler.OUTCOME_BANKER));

  const outcome = document.createElement('div');
  outcome.className = `outcome outcome-${result.outcome.toLowerCase()}`;
  outcome.textContent = result.outcome === RoundSettler.OUTCOME_TIE ? 'Tie' : `${result.outcome === RoundSettler.OUTCOME_PLAYER ? 'Player' : 'Banker'} wins`;

  container.appendChild(title);
  container.appendChild(hands);
  container.appendChild(outcome);
  container.appendChild(createPayoutTable(result.outcome));
}

function createPayoutTable(outcome) {
  const table = document.createElement('table');
  table.className = 'payout-table';

  const rows = PayoutCalculator.BET_TYPES.map(betType => {
    const cents = PayoutCalculator.getReturnCents(betType, outcome);
    let status = 'Lose';
    if (cents === PayoutCalculator.PUSH_RETURN_CENTS) {
      status = 'Push';
    } else if (cents > 0) {
      status = 'Win';
    }
    return `<tr class="payout-${status.toLowerCase()}"><td>${betType}</td><td>${status}</td><td>x${(cents / 100).toFixed(2)}</td></tr>`;
  }).join('');

  table.innerHTML = `<thead><tr><th>Bet</th><th>Result</th><th>Return</th></tr></thead><tbody>${rows}</tbody>`;
  return table;
}

function describeBankerRule(result) {
  if (result.natural) {
    return 'Natural (8 or 9) on the first two cards — no third cards are drawn.';
  }
  if (!result.playerDraws) {
    return `Player stood on ${result.playerInitialTotal}, so the Banker draws on 0-5 and stands on 6-7. Banker has ${result.bankerInitialTotal} → ${result.bankerDraws ? 'draws' : 'stands'}.`;
  }
  return `Player drew a third card with value ${result.playerThirdValue}. Banker has ${result.bankerInitialTotal} → ${result.bankerDraws ? 'draws' : 'stands'} according to the tableau.`;
}

function renderExplanation(container, data) {
  const { hashes, draws, result } = data;
  const clientSeed = escapeHtml(appState.clientSeed);
  const nonce = escapeHtml(appState.nonce);
  const serverSeed = escapeHtml(appState.serverSeed);

  const playerUsed = new Set(result.playerDraws ? [0, 2, 4] : [0, 2]);
  const bankerUsed = new Set(result.bankerDraws ? [1, 3, 5] : [1, 3]);

  const drawRows = draws.map((draw, index) => {
    const used = playerUsed.has(index) || bankerUsed.has(index);
    return `
      <tr class="${used ? '' : 'unused-row'}">
        <td>${index}</td>
        <td>${DEAL_ORDER_LABELS[index]}</td>
        <td>[${index * CardsGenerator.CHARS_PER_CARD}, ${(index + 1) * CardsGenerator.CHARS_PER_CARD})</td>
        <td>${draw.hex}</td>
        <td>${draw.u}</td>
        <td>${draw.code}</td>
        <td>${Card.label(draw.code)}</td>
        <td>${RoundSettler.cardValue(draw.code)}</td>
        <td>${used ? 'Dealt' : 'Not used'}</td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="calculation-explanation">
      <h3>Explanation</h3>

      <div class="explanation-step">
        <h4>Step 1: Calculate HMAC-SHA512 round hashes</h4>
        <p>Two round hashes are calculated and joined into one hex string:</p>
        ${hashes.map((hash, i) => `<pre>hmacSha512("${clientSeed}:${nonce}:${i}", "${serverSeed}") = ${hash}</pre>`).join('')}
      </div>

      <div class="explanation-step">
        <h4>Step 2: Generate 6 cards</h4>
        <p>All 6 cards a round can use are committed up front in deal order <b>P1 B1 P2 B2 P3 B3</b>.
          Card <b>j</b> is read from hex chars <b>[8j, 8j + 8)</b> as an unsigned 32-bit integer <b>u</b> and mapped to a card code
          <b>floor(u × 52 / 2^32)</b> in 0..51. Each card is an independent 1-in-52 draw (unlimited deck, duplicates are possible).</p>
        <p>Card code = <b>rank × 4 + suit</b>, rank 0 = Two .. 12 = Ace, suits: ${CARD_SUITS.map((suit, i) => `${i} = ${SUIT_SYMBOLS[suit]}`).join(', ')}.
          Card value: Ace = 1, Two..Nine = face value, Ten/J/Q/K = 0.</p>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr><th>#</th><th>Position</th><th>Hex chars</th><th>Hex</th><th>u</th><th>Code</th><th>Card</th><th>Value</th><th>Status</th></tr>
            </thead>
            <tbody>${drawRows}</tbody>
          </table>
        </div>
      </div>

      <div class="explanation-step">
        <h4>Step 3: Apply the third-card rules</h4>
        <p>Hand total = sum of card values mod 10.
          Player: ${Card.label(draws[0].code)} + ${Card.label(draws[2].code)} = <b>${result.playerInitialTotal}</b>,
          Banker: ${Card.label(draws[1].code)} + ${Card.label(draws[3].code)} = <b>${result.bankerInitialTotal}</b>.</p>
        <p>If either hand has 8 or 9 it is a natural and both stand. Otherwise the Player draws on 0-5 and stands on 6-7.
          Player ${result.natural ? 'stands (natural)' : (result.playerDraws ? `draws ${Card.label(draws[4].code)}` : 'stands')}.</p>
        <p>${describeBankerRule(result)}${result.bankerDraws ? ` Banker draws ${Card.label(draws[5].code)}.` : ''}</p>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr><th>Banker total</th><th>Banker draws when Player's third card value is</th></tr>
            </thead>
            <tbody>
              <tr><td>0-2</td><td>Always</td></tr>
              <tr><td>3</td><td>Anything except 8</td></tr>
              <tr><td>4</td><td>2-7</td></tr>
              <tr><td>5</td><td>4-7</td></tr>
              <tr><td>6</td><td>6-7</td></tr>
              <tr><td>7</td><td>Never (stands)</td></tr>
            </tbody>
          </table>
        </div>
        <p>Final totals: Player <b>${result.playerTotal}</b>, Banker <b>${result.bankerTotal}</b> → <b>${result.outcome}</b>.</p>
      </div>

      <div class="explanation-step">
        <h4>Step 4: Payouts</h4>
        <p>Fixed returns per staked unit: Player win <b>x2.00</b>, Banker win <b>x1.95</b> (5% commission), Tie win <b>x9.00</b>.
          On a tie Player and Banker bets are pushed (<b>x1.00</b>, stake refund). Losing bets return 0.</p>
      </div>
    </div>
  `;
}

function handleServerSeedChange(event) {
  appState.serverSeed = event.target.value;
  updateResults();
}

function handleNonceChange(event) {
  appState.nonce = event.target.value;
  updateResults();
}

function handleClientSeedChange(event) {
  appState.clientSeed = event.target.value;
  updateResults();
}

function initApp() {
  document.getElementById('server-seed-input').addEventListener('input', handleServerSeedChange);
  document.getElementById('nonce-input').addEventListener('input', handleNonceChange);
  document.getElementById('client-seed-input').addEventListener('input', handleClientSeedChange);

  renderResults();
}

document.addEventListener('DOMContentLoaded', initApp);
