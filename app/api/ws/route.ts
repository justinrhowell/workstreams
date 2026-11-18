import { boardData } from "@/lib/ws/server"
import { json } from "@/lib/ws/route-helpers"

export const dynamic = "force-dynamic"
export const GET = () => json(boardData)
