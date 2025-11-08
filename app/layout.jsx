export const metadata = {
  title: "Chemical JSON Agent",
  description:
    "Parse price-list PDFs into structured pages for downstream grouping & spec extraction.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
          background: "#0b1220",
          color: "#e6eefc",
        }}
      >
        <div style={{ maxWidth: 980, margin: "0 auto", padding: "24px" }}>
          {children}
        </div>
      </body>
    </html>
  );
}
