import { redirect } from "next/navigation";

/** 在庫一覧は `/history` に集約（旧リンク・ブックマーク用） */
export default function InventoryPage() {
  redirect("/history");
}
