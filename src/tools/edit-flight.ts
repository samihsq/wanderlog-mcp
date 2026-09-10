import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import {
  formatFlightLabel,
  isFlightBlock,
  resolveFlightRef,
} from "../resolvers/flight-ref.js";
import type { AirportEndpoint, FlightBlock } from "../types.js";
import { assertBlockAtPath, findBlockById, isValidDate, submitOp } from "./shared.js";

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const editFlightInputSchema = {
  trip_key: z.string().min(1).describe("The trip whose flight to edit."),
  flight: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Which flight to edit. Omit when the trip has one flight. Otherwise: 'outbound' or 'return', a route ('SFO to NRT'), a designator ('JL 57'), a bare number ('57'), an airport code ('NRT'), a departure date ('2026-09-11'), or an airline name. Supports ordinals: '2nd flight', 'last flight'.",
    ),
  airline_name: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Corrected airline name, e.g. 'Japan Airlines'. Wanderlog's own IATA lookup is sometimes wrong (JL resolves to 'Jet Linx Aviation'), and this is how you fix the displayed name.",
    ),
  airline_code: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "must be a 2-letter IATA airline code")
    .optional()
    .describe("Corrected 2-letter IATA airline code, e.g. 'JL'. Normalized to uppercase."),
  flight_number: z
    .union([z.number().int().positive(), z.string().regex(/^\d{1,4}$/)])
    .optional()
    .describe("Corrected flight number, e.g. 57."),
  depart_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .optional()
    .describe("New departure date, YYYY-MM-DD."),
  depart_time: z
    .string()
    .regex(TIME_REGEX, "must be HH:mm")
    .optional()
    .describe("New departure time in local time at the departure airport, HH:mm."),
  arrive_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .optional()
    .describe("New arrival date, YYYY-MM-DD."),
  arrive_time: z
    .string()
    .regex(TIME_REGEX, "must be HH:mm")
    .optional()
    .describe("New arrival time in local time at the arrival airport, HH:mm."),
  depart_airport: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "must be a 3-letter IATA airport code")
    .optional()
    .describe(
      "New departure airport IATA code, e.g. 'HND'. Changing this drops the old airport's cached Google Place data (address and map pin), since those belong to the old airport — pass depart_airport_name to set a readable name.",
    ),
  depart_airport_name: z
    .string()
    .min(1)
    .optional()
    .describe("Display name for the departure airport, e.g. 'Haneda Airport'."),
  arrive_airport: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "must be a 3-letter IATA airport code")
    .optional()
    .describe("New arrival airport IATA code, e.g. 'HND'. Same caveat as depart_airport."),
  arrive_airport_name: z
    .string()
    .min(1)
    .optional()
    .describe("Display name for the arrival airport."),
  confirmation_number: z
    .string()
    .optional()
    .describe("Booking reference. Pass an empty string to clear it."),
  traveler_names: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Names on the booking, replacing the current list. Pass an empty array to clear it.",
    ),
};

export const editFlightDescription = `
Edits an existing flight on a Wanderlog trip: airline, flight number, dates, times, airports,
confirmation number, or the names on the booking. Only the fields you supply change.

Times are local to their own airport, so an eastbound transpacific flight legitimately arrives
at an earlier clock time than it departed — arrival is not required to be after departure.

If the trip has one flight, omit 'flight'. If several match the reference, a numbered list is
returned and nothing changes.
`.trim();

type Args = {
  trip_key: string;
  flight?: string;
  airline_name?: string;
  airline_code?: string;
  flight_number?: number | string;
  depart_date?: string;
  depart_time?: string;
  arrive_date?: string;
  arrive_time?: string;
  depart_airport?: string;
  depart_airport_name?: string;
  arrive_airport?: string;
  arrive_airport_name?: string;
  confirmation_number?: string;
  traveler_names?: string[];
};

function replaceField(
  path: (string | number)[],
  oldValue: unknown,
  newValue: unknown,
): Json0Op {
  return oldValue === undefined
    ? { p: path, oi: newValue }
    : { p: path, od: oldValue, oi: newValue };
}

function endpointOps(
  endpoint: AirportEndpoint | undefined,
  path: (string | number)[],
  which: "depart" | "arrive",
  date: string | undefined,
  time: string | undefined,
  code: string | undefined,
  name: string | undefined,
): { ops: Json0Op[]; changes: string[] } {
  const ops: Json0Op[] = [];
  const changes: string[] = [];

  // The endpoint object itself can be missing on partial / email-imported
  // blocks, so write it whole rather than addressing keys inside nothing.
  if (!endpoint) {
    if (!date && !time && !code) return { ops, changes };
    const created: AirportEndpoint & { type: string } = { type: which };
    if (date) created.date = date;
    if (time) created.time = time;
    if (code) {
      created.airport = { iata: code.toUpperCase(), name: name ?? code.toUpperCase() };
    }
    ops.push({ p: path, oi: created });
    if (date) changes.push(`${which} date → ${date}`);
    if (time) changes.push(`${which} time → ${time}`);
    if (code) changes.push(`${which} airport → ${code.toUpperCase()}`);
    return { ops, changes };
  }

  if (date !== undefined && date !== endpoint.date) {
    ops.push(replaceField([...path, "date"], endpoint.date, date));
    changes.push(`${which} date ${endpoint.date ?? "(unset)"} → ${date}`);
  }
  if (time !== undefined && time !== endpoint.time) {
    ops.push(replaceField([...path, "time"], endpoint.time, time));
    changes.push(`${which} time ${endpoint.time ?? "(unset)"} → ${time}`);
  }

  const airportPath = [...path, "airport"];
  const airport = endpoint.airport as
    | (Record<string, unknown> & { iata?: string; name?: string; cityName?: string })
    | undefined;
  const normalizedCode = code?.toUpperCase();

  if (normalizedCode && normalizedCode !== airport?.iata) {
    if (!airport) {
      ops.push({
        p: airportPath,
        oi: { iata: normalizedCode, name: name ?? normalizedCode },
      });
    } else {
      ops.push(replaceField([...airportPath, "iata"], airport.iata, normalizedCode));
      // The old name, city and cached Google Place describe a different
      // airport. Keeping them would render a confidently wrong location, so
      // replace what we can and drop what we cannot rebuild.
      ops.push(
        replaceField([...airportPath, "name"], airport.name, name ?? normalizedCode),
      );
      if ("cityName" in airport) {
        ops.push({ p: [...airportPath, "cityName"], od: airport.cityName });
      }
      if ("googlePlace" in airport) {
        ops.push({ p: [...airportPath, "googlePlace"], od: airport.googlePlace });
      }
    }
    changes.push(`${which} airport ${airport?.iata ?? "(unset)"} → ${normalizedCode}`);
  } else if (name && airport && name !== airport.name) {
    ops.push(replaceField([...airportPath, "name"], airport.name, name));
    changes.push(`${which} airport name → ${name}`);
  }

  return { ops, changes };
}

export function buildFlightEditOps(
  block: FlightBlock,
  blockPath: (string | number)[],
  args: Args,
): { ops: Json0Op[]; changes: string[] } {
  const ops: Json0Op[] = [];
  const changes: string[] = [];

  const info = block.flightInfo as
    | (Record<string, unknown> & {
        airline?: Record<string, unknown> & { iata?: string; name?: string };
        number?: number | string;
      })
    | undefined;
  const infoPath = [...blockPath, "flightInfo"];

  if (args.airline_name || args.airline_code || args.flight_number !== undefined) {
    const numberValue =
      args.flight_number === undefined
        ? undefined
        : typeof args.flight_number === "string"
          ? Number.parseInt(args.flight_number, 10)
          : args.flight_number;

    if (!info) {
      const created: Record<string, unknown> = {};
      if (args.airline_name || args.airline_code) {
        created.airline = {
          ...(args.airline_code ? { iata: args.airline_code.toUpperCase() } : {}),
          ...(args.airline_name ? { name: args.airline_name } : {}),
        };
      }
      if (numberValue !== undefined) created.number = numberValue;
      ops.push({ p: infoPath, oi: created });
      if (args.airline_code) changes.push(`airline code → ${args.airline_code.toUpperCase()}`);
      if (args.airline_name) changes.push(`airline → ${args.airline_name}`);
      if (numberValue !== undefined) changes.push(`flight number → ${numberValue}`);
    } else {
      const airlinePath = [...infoPath, "airline"];
      const airline = info.airline;
      if (!airline && (args.airline_name || args.airline_code)) {
        ops.push({
          p: airlinePath,
          oi: {
            ...(args.airline_code ? { iata: args.airline_code.toUpperCase() } : {}),
            ...(args.airline_name ? { name: args.airline_name } : {}),
          },
        });
        if (args.airline_code) changes.push(`airline code → ${args.airline_code.toUpperCase()}`);
        if (args.airline_name) changes.push(`airline → ${args.airline_name}`);
      } else if (airline) {
        const code = args.airline_code?.toUpperCase();
        if (code && code !== airline.iata) {
          ops.push(replaceField([...airlinePath, "iata"], airline.iata, code));
          // The ICAO code belongs to the old carrier; a stale one is worse
          // than none, and we have no lookup table to derive the new one.
          if ("icao" in airline) {
            ops.push({ p: [...airlinePath, "icao"], od: airline.icao });
          }
          changes.push(`airline code ${airline.iata ?? "(unset)"} → ${code}`);
        }
        if (args.airline_name && args.airline_name !== airline.name) {
          ops.push(replaceField([...airlinePath, "name"], airline.name, args.airline_name));
          // Wanderlog displays localizedName when it is present.
          if ("localizedName" in airline) {
            ops.push(
              replaceField(
                [...airlinePath, "localizedName"],
                airline.localizedName,
                args.airline_name,
              ),
            );
          }
          changes.push(`airline ${airline.name ?? "(unset)"} → ${args.airline_name}`);
        }
      }
      if (numberValue !== undefined && numberValue !== info.number) {
        ops.push(replaceField([...infoPath, "number"], info.number, numberValue));
        changes.push(`flight number ${info.number ?? "(unset)"} → ${numberValue}`);
      }
    }
  }

  const depart = endpointOps(
    block.depart,
    [...blockPath, "depart"],
    "depart",
    args.depart_date,
    args.depart_time,
    args.depart_airport,
    args.depart_airport_name,
  );
  ops.push(...depart.ops);
  changes.push(...depart.changes);

  const arrive = endpointOps(
    block.arrive,
    [...blockPath, "arrive"],
    "arrive",
    args.arrive_date,
    args.arrive_time,
    args.arrive_airport,
    args.arrive_airport_name,
  );
  ops.push(...arrive.ops);
  changes.push(...arrive.changes);

  if (args.confirmation_number !== undefined) {
    const record = block as unknown as Record<string, unknown>;
    const currentConf = record.confirmationNumber as string | undefined;
    if (args.confirmation_number !== (currentConf ?? "")) {
      ops.push(
        replaceField([...blockPath, "confirmationNumber"], currentConf, args.confirmation_number),
      );
      changes.push(
        `confirmation → ${args.confirmation_number === "" ? "(cleared)" : args.confirmation_number}`,
      );
    }
  }

  if (args.traveler_names !== undefined) {
    const current = block.travelerNames;
    if (JSON.stringify(current ?? []) !== JSON.stringify(args.traveler_names)) {
      ops.push(replaceField([...blockPath, "travelerNames"], current, args.traveler_names));
      changes.push(
        `travelers → ${args.traveler_names.length > 0 ? args.traveler_names.join(", ") : "(cleared)"}`,
      );
    }
  }

  return { ops, changes };
}

export async function editFlight(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const editableKeys = [
      "airline_name",
      "airline_code",
      "flight_number",
      "depart_date",
      "depart_time",
      "arrive_date",
      "arrive_time",
      "depart_airport",
      "depart_airport_name",
      "arrive_airport",
      "arrive_airport_name",
      "confirmation_number",
      "traveler_names",
    ] as const;
    if (editableKeys.every((key) => args[key] === undefined)) {
      throw new WanderlogValidationError(
        `Nothing to edit — supply at least one of ${editableKeys.join(", ")}.`,
      );
    }
    for (const [label, value] of [
      ["depart_date", args.depart_date],
      ["arrive_date", args.arrive_date],
    ] as const) {
      if (value !== undefined && !isValidDate(value)) {
        throw new WanderlogValidationError(`Invalid ${label}: "${value}". Use YYYY-MM-DD.`);
      }
    }

    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      const resolved = resolveFlightRef(trip, args.flight);

      if (resolved.kind === "none") {
        throw new WanderlogError(
          args.flight
            ? `No flight matching "${args.flight}" found in "${trip.title}"`
            : `"${trip.title}" has no flights to edit`,
          "flight_not_found",
          {
            hint: "Use wanderlog_get_trip to see the trip's flights.",
          },
        );
      }
      if (resolved.kind === "ambiguous") {
        const lines = resolved.candidates.map(
          (c, i) => `  ${i + 1}. ${formatFlightLabel(c.block)}`,
        );
        return {
          response: {
            content: [
              {
                type: "text" as const,
                text: `${args.flight ? `"${args.flight}" matches` : `"${trip.title}" has`} ${resolved.candidates.length} flights:\n${lines.join("\n")}\n\nRe-call with a designator ('JL 57'), a route ('SFO to NRT'), 'outbound' / 'return', or an ordinal ('2nd flight').`,
              },
            ],
            isError: true,
          },
        };
      }

      const blockId = resolved.match.block.id;
      const located = findBlockById(trip, blockId);
      if (!located) throw new WanderlogError("Flight moved or was removed", "stale_target");
      const block = assertBlockAtPath(
        trip,
        located.sectionIndex,
        located.blockIndex,
        blockId,
      );
      if (!isFlightBlock(block)) {
        throw new WanderlogValidationError(
          `Block #${blockId} is a ${block.type}, not a flight.`,
        );
      }

      const before = formatFlightLabel(block);
      const blockPath = [
        "itinerary",
        "sections",
        located.sectionIndex,
        "blocks",
        located.blockIndex,
      ];
      const { ops, changes } = buildFlightEditOps(block, blockPath, args);
      if (ops.length === 0) {
        return {
          response: {
            content: [
              {
                type: "text" as const,
                text: `No changes — ${before} already has those values.`,
              },
            ],
          },
        };
      }
      await submit(ops);

      // Verify against the post-submit snapshot rather than trusting the ack:
      // reporting success on a write that did not land is the failure mode
      // that costs the most trust.
      const after = findBlockById(entry.snapshot, blockId)?.block;
      if (!after || !isFlightBlock(after)) {
        throw new WanderlogError("Flight edit could not be verified", "stale_target");
      }
      const mismatches: string[] = [];
      if (args.depart_date && after.depart?.date !== args.depart_date) {
        mismatches.push("depart_date");
      }
      if (args.depart_time && after.depart?.time !== args.depart_time) {
        mismatches.push("depart_time");
      }
      if (args.arrive_date && after.arrive?.date !== args.arrive_date) {
        mismatches.push("arrive_date");
      }
      if (args.arrive_time && after.arrive?.time !== args.arrive_time) {
        mismatches.push("arrive_time");
      }
      if (
        args.airline_name &&
        after.flightInfo?.airline?.name !== args.airline_name
      ) {
        mismatches.push("airline_name");
      }
      if (
        args.airline_code &&
        after.flightInfo?.airline?.iata !== args.airline_code.toUpperCase()
      ) {
        mismatches.push("airline_code");
      }
      if (mismatches.length > 0) {
        throw new WanderlogError(
          `Flight edit did not apply cleanly (${mismatches.join(", ")} did not take)`,
          "stale_target",
          { hint: "Re-read the trip with wanderlog_get_trip before retrying." },
        );
      }

      return { before, after: formatFlightLabel(after), changes, tripTitle: trip.title };
    });
    if ("response" in result && result.response) return result.response;

    return {
      content: [
        {
          type: "text",
          text: `Updated flight in "${result.tripTitle}": ${result.changes.join(", ")}.\nNow: ${result.after}`,
        },
      ],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
