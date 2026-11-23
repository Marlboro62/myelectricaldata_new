"""Passerelle en maintenance : page HTML de nginx au lieu de JSON (issue hassio-addons#48, logs du 20/11).

L'erreur de lecture JSON « Expecting value: line 1 column 1 (char 0) » remplaçait le refus HTTP :
message incompréhensible, et statut perdu pour les appelants (404 Zen Flex, 403 des PDL partagés).
"""

import httpx
import pytest
from unittest.mock import AsyncMock

from src.adapters.myelectricaldata import GatewayHTTPError, MyElectricalDataAdapter
from src.routers.sync import _gateway_error

PAGE_NGINX = (
    "<html><head><title>503 Service Temporarily Unavailable</title></head><body>"
    "<center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>nginx</center></body></html>"
)


def make_adapter(response: httpx.Response) -> MyElectricalDataAdapter:
    adapter = MyElectricalDataAdapter()
    adapter.base_url = "https://passerelle.example/api"
    adapter._ensure_authenticated = AsyncMock(return_value="jeton")
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: response))
    adapter.get_client = AsyncMock(return_value=client)
    return adapter


async def test_page_html_503_message_lisible() -> None:
    adapter = make_adapter(httpx.Response(503, text=PAGE_NGINX, headers={"Content-Type": "text/html"}))

    with pytest.raises(GatewayHTTPError) as excinfo:
        await adapter._make_request("GET", "/tempo/days")

    assert isinstance(excinfo.value, httpx.HTTPStatusError)
    assert excinfo.value.response.status_code == 503
    message = str(excinfo.value)
    assert "Passerelle MyElectricalData indisponible" in message
    assert "HTTP 503 Service Unavailable" in message
    assert "Expecting value" not in message


@pytest.mark.parametrize("status", [401, 403])
async def test_refus_html_garde_son_statut(status: int) -> None:
    adapter = make_adapter(httpx.Response(status, text="<html>refus</html>"))

    with pytest.raises(GatewayHTTPError) as excinfo:
        await adapter._make_request("GET", "/admin/shared-pdls")

    assert "requête refusée" in str(excinfo.value)
    # L'écran des PDL partagés reconnaît de nouveau le compte non administrateur
    assert _gateway_error(excinfo.value).status_code == 403


async def test_erreur_json_inchangee() -> None:
    adapter = make_adapter(httpx.Response(400, json={"error": "invalid_request", "error_description": "dates"}))

    with pytest.raises(ValueError, match="invalid_request: dates"):
        await adapter._make_request("GET", "/enedis/consumption")
