import { trashAction, trashData } from "@/lib/ws/server"
import { readJson, writeJson } from "@/lib/ws/route-helpers"

export const dynamic = "force-dynamic"
export const GET = (req: Request) => readJson(req, trashData)
export const POST = (req: Request) => writeJson(req, trashAction)
