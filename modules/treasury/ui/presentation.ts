import {
  Avatar,
  Button,
  Card,
  Group,
  Text,
  Section,
  List,
  ListItem,
  Badge,
} from "../../../packages/ui/src/index.ts";
import {
  t,
  displayAmount,
  type Locale,
} from "../../../packages/i18n/src/index.ts";
export type Person = { name: string; frogId: string } | null;
export type Wallet = {
  address: string;
  balances: { TON: string; JPEGPE: string } | null;
  asOf: string | null;
  stale: boolean;
  historyStale: boolean;
  indexedThrough: string | null;
  signers: Person[] | null;
  signersAsOf: string | null;
  signersStale: boolean;
};
export type Transaction = {
  id: string;
  at: string;
  direction: "in" | "out";
  token: "TON" | "JPEGPE";
  amount: string;
  person: Person;
  decisions: { proposalId: string; evidenceId: string; title: string }[];
};
const tokens = ["TON", "JPEGPE"] as const;
export function presentation(locale: Locale) {
  const text = (
    key: Parameters<typeof t>[1],
    values: Record<string, string> = {},
  ) => t(locale, key, values);
  function format(read: () => string, fallback: string) {
    try {
      return read();
    } catch {
      return fallback;
    }
  }
  const time = (value: string | null) =>
    value
      ? format(
          () =>
            new Intl.DateTimeFormat(locale, {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: "UTC",
            }).format(new Date(value)),
          value,
        )
      : text("treasury.unknown");
  const amount = (raw: string, token: string) => {
    const units = BigInt(raw);
    const fraction = (units % 1_000_000_000n)
      .toString()
      .padStart(9, "0")
      .replace(/0+$/, "");
    const exact = `${String(units / 1_000_000_000n)}${fraction ? `${locale === "uk" ? "," : "."}${fraction}` : ""}`;
    return `${format(() => displayAmount({ raw, decimals: 9 }, locale, 0, 9) ?? exact, exact)} ${token}`;
  };
  const rowAmount = (raw: string, token: string) =>
    BigInt(raw) >= 1_000_000_000_000_000n
      ? format(
          () =>
            `${new Intl.NumberFormat(locale, {
              notation: "compact",
              maximumFractionDigits: 1,
            }).format(Number(raw) / 1e9)} ${token}`,
          amount(raw, token),
        )
      : amount(raw, token);
  const styled = <T extends HTMLElement>(element: T, name: string): T => {
    element.classList.add(`rada-treasury-${name}`);
    return element;
  };
  const tokenIcon = (token: string) =>
    styled(
      Avatar({
        name: token,
        imageUrl: token === "TON" ? "/profile/ton.svg" : "/profile/jpegpe.webp",
      }),
      "token",
    );
  function icon(kind: "wallet" | "chevron") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      kind === "chevron"
        ? "m9 5 7 7-7 7"
        : "M5 7V5a2 2 0 0 1 2-2h10v4M5 7h12a3 3 0 0 1 3 3v9a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3Zm15 7h-5a3 3 0 0 0 0 6h5",
    );
    svg.append(path);
    return svg;
  }
  function summary(wallets: Wallet[]) {
    const known = wallets.filter((w) => w.balances);
    if (!known.length) return null;
    const marks = styled(Group(tokens.map(tokenIcon)), "symbols");
    const eyebrow = styled(
      Group([Text(text("treasury.assets")), marks]),
      "eyebrow",
    );
    const totals = styled(
      Group(
        tokens.map((token) => {
          const total = known.reduce(
            (sum, w) => sum + BigInt(w.balances?.[token] ?? "0"),
            0n,
          );
          return Text(amount(total.toString(), token));
        }),
      ),
      "total",
    );
    return styled(
      Card({
        label: text("treasury.assets"),
        children: [
          eyebrow,
          totals,
          ...(known.length !== wallets.length
            ? [Text(text("treasury.partial"))]
            : []),
          ...(wallets.some((w) => w.stale)
            ? [Badge(text("treasury.stale"))]
            : []),
        ],
      }),
      "summary",
    );
  }
  function wallet(w: Wallet, index: number) {
    const detailsContent = () => [
      Text(w.address, { breakAnywhere: true }),
      Text(text("treasury.asOf", { time: time(w.asOf) })),
      ...(w.stale ? [Badge(text("treasury.stale"))] : []),
      Text(text("treasury.history", { time: time(w.indexedThrough) })),
      ...(w.historyStale ? [Badge(text("treasury.incomplete"))] : []),
      Section({
        title: text("treasury.signers"),
        children: [
          Text(text("treasury.asOf", { time: time(w.signersAsOf) })),
          ...(w.signersStale ? [Badge(text("treasury.stale"))] : []),
          w.signers === null
            ? Text(text("treasury.unknown"))
            : List({
                children: w.signers.map((p) =>
                  ListItem({
                    title: p?.name ?? text("treasury.anonymous"),
                  }),
                ),
              }),
        ],
      }),
    ];
    const details = styled(Group(), "details");
    details.hidden = true;
    details.id = `treasury-wallet-${String(index)}`;
    const name = text("treasury.multisig");
    const title = styled(Text(name), "name");
    const chips = styled(
      Group([
        ...tokens.map(tokenIcon),
        Text(tokens.map((token) => text(`treasury.${token}`)).join(" · ")),
      ]),
      "chips",
    );
    const copy = styled(Group([title, chips]), "copy");
    const values = styled(
      Group(
        w.balances
          ? tokens.map((token) => {
              const raw = w.balances?.[token] ?? "0";
              const value = Text(rowAmount(raw, token));
              value.title = amount(raw, token);
              return value;
            })
          : [Text(text("treasury.unknown"))],
      ),
      "values",
    );
    const leading = styled(Group([icon("wallet")]), "wallet-icon");
    const row = styled(
      Button(name, {
        variant: "ghost",
        ariaLabel: name,
        onClick: () => {
          details.hidden = !details.hidden;
          details.replaceChildren(...(details.hidden ? [] : detailsContent()));
          row.setAttribute("aria-expanded", String(!details.hidden));
        },
      }),
      "wallet",
    );
    row.title = w.balances
      ? `${name}, ${tokens.map((token) => amount(w.balances?.[token] ?? "0", token)).join(", ")}`
      : name;
    row.dataset.focusKey = details.id;
    row.setAttribute("aria-expanded", "false");
    row.setAttribute("aria-controls", details.id);
    row.replaceChildren(leading, copy, values, icon("chevron"));
    return ListItem({ children: [row, details] });
  }
  function history(entries: Transaction[], openDecision: (id: string) => void) {
    const groups = new Map<string, Transaction[]>();
    for (const entry of entries) {
      const day = entry.at.slice(0, 10);
      groups.set(day, [...(groups.get(day) ?? []), entry]);
    }
    return [...groups].map(([day, movements]) => {
      const date = format(
        () =>
          new Intl.DateTimeFormat(locale, {
            day: "numeric",
            month: "short",
            timeZone: "UTC",
          }).format(new Date(day)),
        day,
      );
      const list = styled(
        List({
          label: date,
          children: movements.map((e) => {
            const name = e.person?.name ?? text("treasury.anonymous");
            const direction = text(
              e.direction === "in" ? "treasury.incoming" : "treasury.outgoing",
            );
            const row = styled(
              ListItem({
                leading: e.person
                  ? Avatar({ name, frogId: e.person.frogId })
                  : tokenIcon(e.token),
                title: name,
                description: `${e.direction === "in" ? "→" : "←"} ${text("treasury.multisig")}`,
                children: [
                  styled(
                    Text(
                      `${e.direction === "in" ? "+" : "−"}${rowAmount(e.amount, e.token)}`,
                    ),
                    "quantity",
                  ),
                ],
                actions: e.decisions.map((d) =>
                  Button(text("treasury.decision", { title: d.title }), {
                    variant: "ghost",
                    onClick: () => {
                      openDecision(d.proposalId);
                    },
                  }),
                ),
              }),
              "movement",
            );
            row.setAttribute(
              "aria-label",
              `${name}, ${direction}, ${amount(e.amount, e.token)}, ${time(e.at)}`,
            );
            row.title = row.getAttribute("aria-label") ?? "";
            return row;
          }),
        }),
        "movements",
      );
      return styled(Group([styled(Text(date), "day"), list]), "date-group");
    });
  }
  return { text, styled, summary, wallet, history };
}
