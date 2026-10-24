import { ChevronLeft } from 'lucide-react'
import { useCatalogStore } from '../store/catalogStore'

import { useEffect, useMemo, useState, useCallback } from 'react'
import type { CatalogGenreSummary, CatalogArtistSummary } from '../services/catalog/types'
import { useAppShellStore } from '../store/appShellStore'
import { artworkUrl } from '../utils/artworkUrl'
import { ArtistCard } from './ArtistsView'
import { MediaGrid, MediaGridSkeleton } from './MediaTile'
import { Button, PageHeader, PageStatus, SearchField } from './ui'

const rememberedGenres = new Map<string, string | null>()

function GenreCard({ genre, onClick }: { genre: CatalogGenreSummary; onClick: () => void }) {
  const cover = artworkUrl(genre.artworkId, null) ?? genre.artworkUrl ?? null

  return (
    <button
      onClick={onClick}
      className="group relative flex flex-col justify-between aspect-[4/3] overflow-hidden rounded-xl bg-gradient-to-br from-white/[0.07] to-white/[0.02] border border-white/5 hover:border-white/20 p-4 text-left transition-colors focus:outline-none"
    >
      {cover && (
        <img
          src={cover}
          className="absolute inset-0 h-full w-full object-cover opacity-35 transition-opacity duration-200 group-hover:opacity-45"
          loading="lazy"
          aria-hidden="true"
          onError={(event) => {
            event.currentTarget.style.display = 'none'
          }}
        />
      )}
      <span className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/45 to-black/75" aria-hidden="true" />
      <span className="relative text-base font-semibold text-zinc-100 truncate group-hover:text-white capitalize">
        {genre.genre}
      </span>
      <span className="relative text-xs text-zinc-300/75">
        {genre.artistCount} {genre.artistCount === 1 ? 'artist' : 'artists'}
      </span>
    </button>
  )
}

export default function GenresView() {
  const providerId = useCatalogStore(s => s.activeProviderId)
  const rememberedSelectedGenre = rememberedGenres.get(providerId) ?? null
  const openCatalogArtist = useAppShellStore((s) => s.openCatalogArtist)
  const [genres, setGenres] = useState<CatalogGenreSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(rememberedSelectedGenre)
  const [artists, setArtists] = useState<CatalogArtistSummary[]>([])
  const [artistsLoading, setArtistsLoading] = useState(false)

  const loadArtistsForGenre = useCallback(async (genre: string, options?: { clear?: boolean }) => {
    setArtistsLoading(true)
    if (options?.clear) setArtists([])
    const rows = await window.puros.library.getArtistsByGenre(providerId, genre)
    if (useCatalogStore.getState().activeProviderId !== providerId) return
    setArtists(rows)
    setArtistsLoading(false)
  }, [providerId])

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const rows = await window.puros.library.getGenres(providerId)
      if (cancelled) return
      setGenres(rows)
      setIsLoading(false)
      if (rememberedSelectedGenre) {
        await loadArtistsForGenre(rememberedSelectedGenre)
      }
    }
    void refresh()
    const unsub = window.puros.on('catalog:changed', () => { void refresh() })
    return () => {
      cancelled = true
      unsub()
    }
  }, [loadArtistsForGenre, providerId])

  const openGenre = useCallback(async (genre: string) => {
    rememberedGenres.set(providerId, genre)
    setSelected(genre)
    await loadArtistsForGenre(genre, { clear: true })
  }, [loadArtistsForGenre, providerId])

  const openArtist = useCallback((artist: CatalogArtistSummary) => {
    void openCatalogArtist(artist.id, 'library')
  }, [openCatalogArtist])

  const visibleGenres = useMemo(() => {
    const term = filter.trim().toLowerCase()
    if (!term) return genres
    return genres.filter((g) => g.genre.toLowerCase().includes(term))
  }, [genres, filter])

  // ── Genre detail (artists in a genre) ──
  if (selected) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <PageHeader
          kicker="Genre"
          title={<span className="capitalize">{selected}</span>}
          subtitle={artistsLoading ? 'Loading…' : `${artists.length} ${artists.length === 1 ? 'artist' : 'artists'}`}
          leading={(
            <Button
              iconOnly
              icon={ChevronLeft}
              label="Back to genres"
              className="mb-1"
              onClick={() => { rememberedGenres.set(providerId, null); setSelected(null); setArtists([]) }}
            />
          )}
        />
        {artistsLoading && artists.length === 0 ? (
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <MediaGridSkeleton count={12} kind="artist" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <MediaGrid>
              {artists.map((artist) => (
                <ArtistCard key={artist.id} artist={artist} onOpen={() => { void openArtist(artist) }} />
              ))}
            </MediaGrid>
          </div>
        )}
      </div>
    )
  }

  // ── Genre list ──
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <PageHeader
        kicker="Library"
        title="Genres"
        subtitle={isLoading ? 'Loading…' : `${genres.length} ${genres.length === 1 ? 'genre' : 'genres'} in this provider`}
        actions={<SearchField value={filter} onChange={setFilter} placeholder="Filter genres" />}
      />

      {isLoading && genres.length === 0 ? (
        <PageStatus fill loading />
      ) : visibleGenres.length === 0 ? (
        <PageStatus
          fill
          title={filter.trim() ? `No genres match “${filter.trim()}”.` : 'No genres yet.'}
          hint={filter.trim() ? undefined : 'Genre tags come from this provider’s library.'}
        />
      ) : (
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-4">
            {visibleGenres.map((genre) => (
              <GenreCard key={genre.genre} genre={genre} onClick={() => { void openGenre(genre.genre) }} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
