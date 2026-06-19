export type AppSchemaApp = {
  id: string;
  slug: string;
  name: string;
  status: string;
};

export type AppDataTableRow = {
  id: string;
  app_id: string;
  slug: string;
  physical_table_name: string;
  display_name: string | null;
  description: string | null;
  primary_key: string;
  owner_column: string | null;
  soft_delete_column: string | null;
  status: string;
  settings_json: unknown;
  created_at: Date;
  updated_at: Date;
};

export type AppDataColumnRow = {
  id: string;
  table_id: string;
  slug: string;
  physical_column_name: string;
  data_type: string;
  is_nullable: boolean;
  default_value_json: unknown;
  is_unique: boolean;
  is_indexed: boolean;
  is_hidden: boolean;
  is_readonly: boolean;
  validation_json: unknown;
  display_json: unknown;
  ordinal_position: number;
  created_at: Date;
  updated_at: Date;
};

export type AppDataIndexRow = {
  id: string;
  table_id: string;
  slug: string;
  index_type: string;
  columns_json: unknown;
  where_json: unknown;
  is_unique: boolean;
  physical_index_name: string;
  created_at: Date;
  updated_at: Date;
};

export type AppDataPolicyRow = {
  id: string;
  table_id: string;
  action: string;
  effect: string;
  roles_json: unknown;
  condition_json: unknown;
  field_mask_json: unknown;
  status: string;
  created_at: Date;
  updated_at: Date;
};
