import ReactMarkdown from "react-markdown";

export function Markdown({ source }: { source: string }) {
  return (
    <div className="prose-sm max-w-none [&_h1]:text-lg [&_h2]:text-base [&_h1]:font-bold [&_h2]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:rounded [&_code]:bg-surface2 [&_code]:px-1">
      <ReactMarkdown>{source}</ReactMarkdown>
    </div>
  );
}
