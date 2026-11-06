import { createDb, migrate } from "../lib/db";

const db = createDb();
const applied = await migrate(db);
db.close();

console.log(
  applied.length > 0
    ? `적용한 마이그레이션: ${applied.join(", ")}`
    : "적용할 마이그레이션이 없습니다",
);
