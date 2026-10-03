import React from "react";

/** Failure remains visible even when charts, exports or partial output exist. */
export function AnalysisErrorNotice({ error }: { error?: string | boolean }) {
  if (!error) return null;
  return (
    <p className="text-sm text-destructive mt-3" role="alert" data-testid="text-analysis-error">
      {typeof error === "string"
        ? error
        : "Fehler bei der Datenabfrage. Die Analyse konnte nicht vollständig geladen werden."}
    </p>
  );
}