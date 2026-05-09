export type LangId =
  | "python" | "javascript" | "typescript" | "tsx"
  | "go" | "rust" | "c" | "cpp" | "java"
  | "ruby" | "bash" | "json" | "yaml" | "html" | "css" | "php";

export const EXT_TO_LANG: Record<string, LangId> = {
  py: "python", pyi: "python",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  go: "go",
  rs: "rust",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp", hh: "cpp",
  java: "java",
  rb: "ruby",
  sh: "bash", bash: "bash",
  json: "json",
  yaml: "yaml", yml: "yaml",
  html: "html", htm: "html",
  css: "css",
  php: "php",
};

export const DEFINITION_QUERIES: Partial<Record<LangId, string>> = {
  python: `
    (function_definition name: (identifier) @name) @function
    (class_definition name: (identifier) @name) @class
  `,
  javascript: `
    (function_declaration name: (identifier) @name) @function
    (method_definition name: (property_identifier) @name) @method
    (class_declaration name: (identifier) @name) @class
    (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @function
    (export_statement declaration: (function_declaration name: (identifier) @name)) @export
    (export_statement declaration: (class_declaration name: (identifier) @name)) @export
    (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]))) @export
  `,
  typescript: `
    (function_declaration name: (identifier) @name) @function
    (method_definition name: (property_identifier) @name) @method
    (class_declaration name: (type_identifier) @name) @class
    (interface_declaration name: (type_identifier) @name) @interface
    (type_alias_declaration name: (type_identifier) @name) @type
    (enum_declaration name: (identifier) @name) @enum
    (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @function
    (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]))) @export
  `,
  tsx: `
    (function_declaration name: (identifier) @name) @function
    (method_definition name: (property_identifier) @name) @method
    (class_declaration name: (type_identifier) @name) @class
    (interface_declaration name: (type_identifier) @name) @interface
    (type_alias_declaration name: (type_identifier) @name) @type
    (enum_declaration name: (identifier) @name) @enum
    (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @function
    (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]))) @export
  `,
  go: `
    (function_declaration name: (identifier) @name) @function
    (method_declaration name: (field_identifier) @name) @method
    (type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @struct
    (type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @interface
    (type_declaration (type_spec name: (type_identifier) @name)) @type
  `,
  rust: `
    (function_item name: (identifier) @name) @function
    (impl_item type: (type_identifier) @name) @impl
    (struct_item name: (type_identifier) @name) @struct
    (enum_item name: (type_identifier) @name) @enum
    (trait_item name: (type_identifier) @name) @trait
  `,
  c: `
    (function_definition declarator: (function_declarator declarator: (identifier) @name)) @function
    (struct_specifier name: (type_identifier) @name) @struct
  `,
  cpp: `
    (function_definition declarator: (function_declarator declarator: (identifier) @name)) @function
    (function_definition declarator: (function_declarator declarator: (qualified_identifier) @name)) @method
    (class_specifier name: (type_identifier) @name) @class
    (struct_specifier name: (type_identifier) @name) @struct
  `,
  java: `
    (method_declaration name: (identifier) @name) @method
    (class_declaration name: (identifier) @name) @class
    (interface_declaration name: (identifier) @name) @interface
    (constructor_declaration name: (identifier) @name) @constructor
  `,
  ruby: `
    (method name: (identifier) @name) @method
    (class name: (constant) @name) @class
    (module name: (constant) @name) @module
  `,
  bash: `
    (function_definition name: (word) @name) @function
  `,
  php: `
    (function_definition name: (name) @name) @function
    (method_declaration name: (name) @name) @method
    (class_declaration name: (name) @name) @class
    (interface_declaration name: (name) @name) @interface
  `,
};

export const CALL_QUERIES: Partial<Record<LangId, string>> = {
  python: `(call function: [(identifier) @name (attribute attribute: (identifier) @name)]) @call`,
  javascript: `(call_expression function: [(identifier) @name (member_expression property: (property_identifier) @name)]) @call`,
  typescript: `(call_expression function: [(identifier) @name (member_expression property: (property_identifier) @name)]) @call`,
  tsx: `(call_expression function: [(identifier) @name (member_expression property: (property_identifier) @name)]) @call`,
  go: `(call_expression function: [(identifier) @name (selector_expression field: (field_identifier) @name)]) @call`,
  rust: `(call_expression function: [(identifier) @name (field_expression field: (field_identifier) @name) (scoped_identifier name: (identifier) @name)]) @call`,
  c: `(call_expression function: [(identifier) @name (field_expression field: (field_identifier) @name)]) @call`,
  cpp: `(call_expression function: [(identifier) @name (field_expression field: (field_identifier) @name) (qualified_identifier name: (identifier) @name)]) @call`,
  java: `(method_invocation name: (identifier) @name) @call`,
  ruby: `(call method: (identifier) @name) @call`,
  bash: `(command name: (command_name) @name) @call`,
  php: `
    (function_call_expression function: [(name) @name (qualified_name) @name]) @call
    (member_call_expression name: (name) @name) @call
    (scoped_call_expression name: (name) @name) @call
  `,
};

export const IMPORT_QUERIES: Partial<Record<LangId, string>> = {
  python: `
    (import_statement name: (dotted_name) @module) @import
    (import_from_statement module_name: (dotted_name) @module) @import
  `,
  javascript: `
    (import_statement source: (string) @module) @import
  `,
  typescript: `
    (import_statement source: (string) @module) @import
  `,
  tsx: `
    (import_statement source: (string) @module) @import
  `,
  go: `
    (import_spec path: (interpreted_string_literal) @module) @import
  `,
  rust: `
    (use_declaration argument: (_) @module) @import
  `,
};
