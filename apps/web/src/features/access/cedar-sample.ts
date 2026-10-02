export const CEDAR_SAMPLE_NEW = `// Describe who may do what. Forbid always wins.
permit (
  principal,
  action == Action::"callTool",
  resource
);
`;
