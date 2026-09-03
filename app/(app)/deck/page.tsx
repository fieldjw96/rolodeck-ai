import type { Metadata } from "next";

import { Deck } from "./deck";

export const metadata: Metadata = {
  title: "Deck · Rolodeck AI",
};

export default function DeckPage() {
  return <Deck />;
}
