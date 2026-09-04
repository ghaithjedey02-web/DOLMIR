/**
 * Class E — the wording the platform itself supplies.
 *
 * A reply is written in two vocabularies. One is the vocabulary of the
 * *letter*: articles, prepositions, courtesy forms, the verbs of
 * acknowledging a request and promising an answer, and the nouns naming the
 * reply's own artefacts — the request, the quotation, the delivery date. That
 * vocabulary asserts nothing about the world and is listed here.
 *
 * The other is the vocabulary of the *business*: a plant, a warehouse, a
 * certification, a framework agreement, a discount, a capability. Every word
 * of that kind is a factual claim, so it is deliberately absent here and must
 * be grounded in verified evidence, an entity record, the company profile or a
 * company rule before a draft may use it.
 *
 * The line between the two is the whole point, so two rules govern additions:
 *
 *   - a word that could complete the sentence "we have / we are / we offer …"
 *     is a business claim and does not belong here;
 *   - a word that only helps the sentence run — or that names the reply, the
 *     request or the calendar — does.
 *
 * `impianto`, `magazzino`, `stabilimento`, `contratto`, `accordo`, `sconto`,
 * `fornitura`, `certificazione`, `ufficio` and `tecnico` are absent on purpose.
 * A company that genuinely uses one of them teaches it through its profile or
 * its terminology list, where it becomes evidence rather than invention.
 *
 * Lookups are accent- and apostrophe-insensitive, so `sarà`, `sara'` and
 * `sara` are the same word and `dell'articolo` is read as `dell` + `articolo`.
 */

/** Strips accents and trailing punctuation so one spelling covers the variants. */
export function normaliseWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** `dell'articolo` is two words; `S.r.l.` is one. */
export function wordParts(token: string): string[] {
  const whole = normaliseWord(token);
  const parts = wordSegments(token);
  return whole.length > 0 ? [whole, ...parts] : parts;
}

/** The pieces an elision separates: `dell'articolo` -> `dell`, `articolo`. */
export function wordSegments(token: string): string[] {
  return token
    .split(/['’]/)
    .map(normaliseWord)
    .filter((part) => part.length > 0);
}

/**
 * Drops the inflectional ending so `flangia` and `flange`, `articolo` and
 * `articoli`, `pezzo` and `pezzi` are one word. Italian marks number and
 * gender on the final vowels, so removing them is enough for the only question
 * asked here: does the message, the catalogue or the profile already contain
 * this word? It is deliberately blunt — it merges a family, never two
 * families, so it can widen what a reply may say only to other forms of a word
 * that is already grounded.
 */
export function stemWord(word: string): string {
  if (word.length < 4) return word;
  const stem = word.replace(/[aeiou]+$/u, '');
  return stem.length >= 3 ? stem : word;
}

const ITALIAN = `
il lo la i gli le un uno una l un dell all nell sull dall quest quell anch
del dello della dei degli delle al allo alla ai agli alle dal dallo dalla dai dagli dalle
nel nello nella nei negli nelle sul sullo sulla sui sugli sulle col coi
di a da in con su per tra fra e ed o od ma pero quindi dunque inoltre infatti oppure
se che chi cui come quando dove mentre anche ancora gia non ne ci vi si mi ti ce ve
io tu lui lei noi voi loro nostro nostra nostri nostre vostro vostra vostri vostre
suo sua suoi sue mio mia miei mie questo questa questi queste quello quella quelli quelle
ogni tutti tutte tutto tutta alcuni alcune qualche nessun nessuna altro altra altri altre
stesso stessa molto poco piu meno solo soltanto sempre mai subito presto
prima dopo entro appena durante secondo circa oltre senza sotto sopra qui qua
essere sono sei siamo siete era erano sara saranno sarebbe stato stata stati state
avere ho hai ha abbiamo avete hanno aveva avevano avra avranno avremmo avuto
potere posso puoi puo possiamo potete possono potra potremo potremmo potuto
dovere devo deve dobbiamo dovete devono dovra dovremo dovuto
volere voglio vuole vogliamo volete vogliono vorremmo vorremo
ricevere ricevo riceve riceviamo ricevuto ricevuta ricevuti ricevute ricezione
confermare confermo conferma confermiamo confermate confermato confermata confermarvi confermarci
inviare invio invia inviamo inviate inviato inviata invieremo inviarvi invierete
comunicare comunico comunica comunichiamo comunicheremo comunicazione comunicarvi
richiedere richiesto richiesta richieste richiesti richiediamo
rispondere risposta rispondiamo risponderemo riscontro riscontrare
dare diamo daremo dato datale trasmettere trasmetteremo
preparare prepariamo prepareremo preparazione predisporre predisporremo
valutare valutiamo valuteremo valutazione esaminare esaminiamo esame
verificare verifichiamo verifica verificato verificata elaborare elaborazione
procedere procediamo procederemo restare restiamo rimanere rimaniamo disposizione
seguire seguito seguira seguiranno seguente seguenti
ringraziare ringraziamo ringraziandovi grazie attendere attesa attendiamo
chiedere chiediamo chiedervi chiediamovi domanda domande
indicare indicarci indicarvi indicazione indicazioni indicato indicata
precisare precisarci precisazione chiarire chiarirci chiarimento chiarimenti
completare completo completa completamento mancare manca mancano mancante mancanti
servire serve servono necessario necessaria necessari necessarie occorre occorrono
buongiorno buonasera salve gentile gentili egregio egregi spettabile spett
cordiali distinti saluti
richiesta richieste offerta offerte preventivo preventivi messaggio riepilogo oggetto
consegna consegne data date termine termini tempo tempi scadenza
giorno giorni giornata lavorativo lavorativi settimana settimane mese mesi ora ore anno anni
quantita articolo articoli prodotto prodotti codice codici riferimento riferimenti
disegno disegni specifica specifiche dettaglio dettagli informazione informazioni
dato dati conferma presa carico interna interno seguito unita unitario
presso tramite mediante relativo relativa relativi relative merito oggetto
allegato allegati allegata cortesia cortese gentilmente possibile possibilmente
eventuale eventuali eventualmente ulteriore ulteriori nuovo nuova nuovi nuove
riguarda riguardano riguardare riguardante riguardo trattare tratta
cadere cade cadono fissato fissata previsto prevista previste previsti
`;

const ENGLISH = `
the a an of to in for on with and or but if that this these those we you your our us it its
i he she they will shall would could should can may might must do does did is are was were be been
please thank thanks kind regards sincerely best dear hello good morning afternoon
receive received receipt request requested requests quotation quotations quote quotes offer offers
send sending sent reply respond response answer confirm confirmed confirmation acknowledge acknowledged
prepare preparing preparation review reviewing internal assessment evaluation evaluate evaluating
following follow follows remain remaining further need needed needs missing complete completing
delivery date dates deadline day days working week weeks month months hour hours year years
quantity quantities item items code codes product products drawing drawings detail details
specification specifications information reference references message subject summary unit units
within after before once as by from at no not only also still soon shortly
`;

/**
 * Every word a draft may use without grounding it in a fact. Nothing here
 * names a company, a person, a place, a product, a capability or a commitment.
 */
export const SYSTEM_LEXICON: ReadonlySet<string> = new Set(
  `${ITALIAN} ${ENGLISH}`
    .split(/\s+/)
    .map(normaliseWord)
    .filter((word) => word.length > 0),
);

/** The lexicon's own stems, so its listed words cover their inflections too. */
export const SYSTEM_LEXICON_STEMS: ReadonlySet<string> = new Set([...SYSTEM_LEXICON].map(stemWord));
