"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Package, History, Users, Database, Layers, Menu, X } from "lucide-react";

const navItems = [
  { href: "/", label: "入庫管理", icon: Package },
  { href: "/history", label: "在庫一覧", icon: History },
  { href: "/suppliers", label: "仕入先管理", icon: Users },
  { href: "/products", label: "商品マスタ", icon: Database },
  { href: "/sku", label: "SKUマスタ", icon: Layers },
] as const;

const buttonBase =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 h-10 px-6 py-2 shadow-sm duration-200";
const buttonInactive = "bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 active:scale-[0.98]";
const buttonActive = "bg-primary text-white border border-primary hover:bg-primary/90 hover:border-primary";

function BarcodeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m-4-8v8m8-8v8M4 4h2v16H4V4zm14 0h2v16h-2V4zM8 4h1v16H8V4zm6 0h1v16h-1V4z" />
    </svg>
  );
}

export default function Header() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 w-full shrink-0 border-b bg-white/80 backdrop-blur-md shadow-sm">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2 text-slate-900 hover:opacity-80 transition-opacity">
          <div className="rounded-lg bg-primary p-1.5 text-white shadow-md shadow-primary/30">
            <BarcodeIcon className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">
            Zaiko Manager <span className="text-xs font-normal text-slate-500 ml-2 bg-slate-100 px-2 py-0.5 rounded-full">Professional</span>
          </h1>
        </Link>

        {/* PC: 横並びボタンメニュー */}
        <nav className="hidden md:flex items-center gap-2">
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${buttonBase} ${isActive ? buttonActive : buttonInactive} gap-1`}
              >
                {Icon && <Icon className="h-4 w-4" />}
                {item.label}
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => alert("ログアウト")}
            className={`${buttonBase} ${buttonInactive} text-slate-500 hover:text-destructive hover:border-destructive/30`}
          >
            ログアウト
          </button>
        </nav>

        {/* スマホ: ハンバーガーボタン */}
        <div className="flex md:hidden items-center gap-2">
          <button
            type="button"
            onClick={() => setMobileOpen((o) => !o)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors"
            aria-expanded={mobileOpen}
            aria-label="メニュー"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* スマホ: ドロップダウンメニュー */}
      {mobileOpen && (
        <div className="md:hidden absolute top-full left-0 right-0 z-40 border-b border-slate-200 bg-white shadow-lg">
          <nav className="flex flex-col p-4 gap-2 max-h-[70vh] overflow-y-auto">
            {navItems.map((item) => {
              const isActive = pathname === item.href;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={`${buttonBase} justify-start px-4 ${isActive ? buttonActive : buttonInactive}gap-2`}
                >
                  {Icon && <Icon className="h-4 w-4 shrink-0" />}
                  {item.label}
                </Link>
              );
            })}
            <button
              type="button"
              onClick={() => { setMobileOpen(false); alert("ログアウト"); }}
              className={`${buttonBase} justify-start px-4 ${buttonInactive} text-slate-500 hover:text-destructive hover:border-destructive/30`}
            >
              ログアウト
            </button>
          </nav>
        </div>
      )}
    </header>
  );
}
