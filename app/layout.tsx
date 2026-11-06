import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ops-bot",
  description: "웹 서비스의 에러·배포 신호를 모아 알리는 운영 모니터링 봇",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
