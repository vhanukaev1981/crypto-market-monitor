import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Crypto Market Monitor",
    short_name: "Market Monitor",
    description: "לוח מחקר ולמידה המבוסס על נתוני שוק קריפטו ציבוריים בלבד",
    start_url: "/",
    display: "standalone",
    background_color: "#07111f",
    theme_color: "#07111f",
    lang: "he",
    dir: "rtl",
  };
}
