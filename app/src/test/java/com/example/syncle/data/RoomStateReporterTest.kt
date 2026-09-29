package com.example.syncle.data

import androidx.compose.ui.geometry.Offset
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RoomStateReporterTest {
    private lateinit var server: MockWebServer

    @Before fun setUp() {
        server = MockWebServer().also { it.start() }
    }

    @After fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `posts state with bearer token and expected body`() =
        runTest {
            server.enqueue(MockResponse().setBody("""{"ok":true}"""))
            val reporter = RoomStateReporter(server.url("/").toString().trimEnd('/'), OkHttpClient())

            val code =
                reporter.report(
                    room = "r1",
                    userId = "u-9",
                    token = "jwt.tok",
                    tableId = "t-3",
                    position = Offset(123.5f, 456.25f),
                    zoneId = "study-hall",
                    zoneKind = "silent",
                )

            assertEquals(200, code)
            val req = server.takeRequest()
            assertEquals("POST", req.method)
            assertEquals("/v1/rooms/r1/state", req.path)
            assertEquals("Bearer jwt.tok", req.getHeader("Authorization"))
            val body = JSONObject(req.body.readUtf8())
            assertEquals("u-9", body.getString("userId"))
            assertEquals("t-3", body.getString("tableId"))
            assertEquals(123.5, body.getDouble("x"), 0.001)
            assertEquals(456.25, body.getDouble("y"), 0.001)
            assertEquals("study-hall", body.getString("zone"))
            assertEquals("silent", body.getString("zone_kind"))
        }

    @Test
    fun `defaults report null zone and none zone_kind`() =
        runTest {
            server.enqueue(MockResponse().setBody("{}"))
            val reporter = RoomStateReporter(server.url("/").toString(), OkHttpClient())
            reporter.report("r1", "u-1", "t", null, Offset.Zero)
            val body = JSONObject(server.takeRequest().body.readUtf8())
            assertTrue(body.isNull("zone"))
            assertEquals("none", body.getString("zone_kind"))
        }

    @Test
    fun `serializes null tableId as JSON null`() =
        runTest {
            server.enqueue(MockResponse().setBody("{}"))
            val reporter = RoomStateReporter(server.url("/").toString(), OkHttpClient())
            reporter.report("r1", "u-1", "t", null, Offset.Zero)
            val body = JSONObject(server.takeRequest().body.readUtf8())
            assertTrue(body.isNull("tableId"))
        }

    @Test
    fun `returns 401 on auth error so caller can refresh`() =
        runTest {
            server.enqueue(MockResponse().setResponseCode(401))
            val reporter = RoomStateReporter(server.url("/").toString(), OkHttpClient())
            assertEquals(401, reporter.report("r1", "u", "tok", null, Offset.Zero))
        }

    @Test
    fun `returns null when backend url is empty`() =
        runTest {
            val reporter = RoomStateReporter("", OkHttpClient())
            assertNull(reporter.report("r1", "u", "tok", null, Offset.Zero))
        }
}
