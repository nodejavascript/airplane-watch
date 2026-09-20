/**
 * historic-document.mjs — the `/historic.json` document, composed once.
 *
 * 🔴 WHY THIS IS A MODULE AND NOT A FUNCTION IN EACH PLACE. The same document is needed in
 * two: `tools/load-historic.mjs` writes it to `site/historic.json` (the file that gets
 * deployed, because a Cloudflare Worker cannot reach Postgres) and `tools/serve.mjs`
 * answers `/historic.json` from the database while developing. Two builders would be two
 * answers to one question, and the second one to be edited would be the wrong one — which
 * is exactly the fault this project has already had once, when the dev server built
 * `/types.json` from Postgres while `site/types.json` said something else and an experiment
 * was invalidated by it.
 *
 * The shape is deliberately the same whether it came from the database or from the file, so
 * the page never has to ask which it got.
 */

/** Whether the feed has ever reported a type, read from the survey's own table. */
async function feedTypes(query) {
  const { rows } = await query('select code from types');
  return new Set(rows.map((row) => row.code));
}

export async function composeHistoric(query) {
  const sites = await query(
    `select s.id, s.icao, s.name, s.url, s.note, s.source, s.read_at,
            n.next_at, n.upcoming, n.days_published
       from historic_sites s left join historic_next n on n.site_id = s.id
      order by s.icao`
  );
  const aircraft = await query(
    `select site_id, their_id, name, event_label, type_code, code_source
       from historic_aircraft order by their_id`
  );
  const flights = await query(
    `select site_id, their_id, their_aircraft_id, begins_at, seats, url
       from historic_flights
      where begins_at > now()
      order by begins_at`
  );
  const inFeed = await feedTypes(query);

  return {
    generated: new Date().toISOString(),
    source: "the operator's own published flight schedule",
    method:
      "Read from the operator's flight-day endpoint, one request per day, two seconds apart. " +
      'Its date parameter is one day ahead of the day it returns — measured against ten dates on ' +
      '20 Sep 2026 — so the offset day is requested, and every event is then checked against the ' +
      'day it claims. If that offset ever changes, this returns nothing for a day rather than the ' +
      "wrong day's flights.",
    caution:
      "These are the operator's scheduled flights, not a promise that the feed will report them. " +
      'A flight that is equipped and transmitting appears in the list above like anything else. ' +
      'An aircraft whose type code has never been reported is marked, because that is a fact ' +
      'about the feed and not about the aircraft.',
    sites: sites.rows.map((row) => ({
      icao: row.icao,
      name: row.name,
      url: row.url,
      note: row.note ?? '',
      source: row.source,
      readAt: new Date(row.read_at).toISOString().slice(0, 10),
      nextAt: row.next_at === null ? null : new Date(row.next_at).toISOString(),
      upcoming: row.upcoming ?? 0,
      daysPublished: row.days_published ?? 0,
      aircraft: aircraft.rows
        .filter((item) => item.site_id === row.id)
        .map((item) => ({
          name: item.name,
          label: item.event_label,
          theirId: item.their_id,
          typeCode: item.type_code,
          codeSource: item.code_source,
          // 🔴 THREE STATES, NOT TWO. `null` means NO SOURCE has been found for this
          // aircraft's type code — which is a different thing from "the feed has not
          // reported it". Printing the second when the first is true would be a claim
          // nobody checked, and it is the claim a reader would act on.
          reported: item.type_code === null ? null : inFeed.has(item.type_code),
        })),
      flights: flights.rows
        .filter((item) => item.site_id === row.id)
        .map((item) => ({
          aircraft: item.their_aircraft_id,
          beginsAt: new Date(item.begins_at).toISOString(),
          seats: item.seats,
          url: item.url,
        })),
    })),
  };
}
